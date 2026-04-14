import { log } from '../config/logging.js';
import poolManager from '../db/poolManager.js';
import measurementRepository from '../models/measurementRepository.js';
import exerciseEntryRepository from '../models/exerciseEntry.js';
import exerciseRepository from '../models/exercise.js';
import activityDetailsRepository from '../models/activityDetailsRepository.js';
import exercisePresetEntryRepository from '../models/exercisePresetEntryRepository.js';
import workoutPresetRepository from '../models/workoutPresetRepository.js';
import measurementService from './measurementService.js';
import moodRepository from '../models/moodRepository.js';
import garminConnectService from '../integrations/garminconnect/garminConnectService.js';
import garminMeasurementMapping from '../integrations/garminconnect/garminMeasurementMapping.js';
import moment from 'moment';
import { loadUserTimezone } from '../utils/timezoneLoader.js';
import { todayInZone, addDays } from '@workspace/shared';
import sleepRepository from '../models/sleepRepository.js';
import goalService from './goalService.js';
import goalRepository from '../models/goalRepository.js';
// Removed AxiosError import as it is never read.

interface GarminData {
  activities?: Record<string, unknown>[];
  workouts?: Record<string, unknown>[];
  workoutName?: string;
  description?: string;
  workoutSegments?: Record<string, unknown>[];
}

interface GarminHealthData {
  stress?: Record<string, unknown>[];
}

interface GarminSet {
  setType: string;
  duration?: number;
  weight?: number;
  repetitionCount?: number;
  notes?: string;
  startTime: string | number | Date;
  exercises?: { name?: string; category?: string }[];
  category?: string;
  stepIndex?: number;
  wktStepId?: number;
}

interface GarminSessionData {
  activity: Record<string, unknown>;
  exercise_sets?: { exerciseSets: GarminSet[] };
  details?: Record<string, unknown>;
  splits?: Record<string, unknown>;
  hr_in_timezones?: Record<string, unknown>[];
}

interface ExerciseGroup {
  name: string;
  stepIndex: number | null;
  exerciseDetails: { category: string };
  sets: Record<string, unknown>[];
  totalDuration: number;
  activeDuration: number;
  startTime: number | null;
  endTime: number | null;
}

interface WorkoutPreset {
  id: string;
  exercises?: Record<string, unknown>[];
}

async function processActivitiesAndWorkouts(
  userId: string,
  data: GarminData,
  startDate: string,
  endDate: string,
  timezone = 'UTC'
) {
  const { activities, workouts } = data;
  let processedCount = 0;
  // Comprehensive cleanup for Garmin-sourced data for the date range
  // This ensures a clean slate for the current sync, preventing duplicates and stale data.
  log(
    'info',
    `[garminService] Performing comprehensive cleanup for Garmin data for user ${userId} from ${startDate} to ${endDate}.`
  );
  await exerciseEntryRepository.deleteExerciseEntriesByEntrySourceAndDate(
    userId,
    startDate,
    endDate,
    'garmin'
  );
  await exercisePresetEntryRepository.deleteExercisePresetEntriesByEntrySourceAndDate(
    userId,
    startDate,
    endDate,
    'garmin'
  );
  // Process Activities and Workouts
  if (activities && Array.isArray(activities)) {
    for (const activityData of activities as Record<string, unknown>[]) {
      // Determine if it's a workout session (with summarizedExerciseSets or exercise_sets)
      // or a simple activity.
      const activity = activityData.activity as
        | Record<string, unknown>
        | undefined;
      const exerciseSets = activityData.exercise_sets as
        | Record<string, unknown>
        | undefined;
      if (
        (activity?.summarizedExerciseSets as unknown[] | undefined)?.length ||
        (exerciseSets?.exerciseSets as unknown[] | undefined)?.length
      ) {
        await processGarminWorkoutSession(
          userId,
          activityData as unknown as GarminSessionData,
          startDate,
          endDate,
          timezone
        );
      } else if (activity) {
        await processGarminSimpleActivity(
          userId,
          activityData as unknown as GarminSessionData,
          timezone
        );
      }
      processedCount++; // Increment for each activity processed
    }
  }
  // Process standalone Workouts (definitions)
  if (workouts && Array.isArray(workouts)) {
    for (const workoutData of workouts) {
      await processGarminWorkoutDefinition(userId, workoutData);
      processedCount++; // Increment for each workout definition processed
    }
  }
  return { processedEntries: processedCount };
}
async function processGarminHealthAndWellnessData(
  userId: string,
  actingUserId: string,
  healthData: GarminHealthData,
  startDate: string,
  endDate: string
) {
  log(
    'info',
    `[garminService] Processing Garmin health and wellness data for user ${userId} from ${startDate} to ${endDate}.`
  );
  const processedResults = [];
  const errors = [];
  try {
    // Process Stress Data
    if (healthData.stress && Array.isArray(healthData.stress)) {
      for (const stressEntry of healthData.stress) {
        const date = stressEntry.date as string;
        const raw_stress_data = stressEntry.raw_stress_data as
          | Record<string, unknown>
          | undefined;
        const derived_mood_value = stressEntry.derived_mood_value as
          | number
          | undefined;
        const derived_mood_notes = stressEntry.derived_mood_notes as
          | string
          | undefined;
        // Store raw stress data as a custom measurement
        if (raw_stress_data) {
          try {
            const customCategory =
              await measurementService.getOrCreateCustomCategory(
                userId,
                actingUserId,
                'Raw Stress Data',
                'text',
                'JSON'
              );
            await measurementService.upsertCustomMeasurementEntry(
              userId,
              actingUserId,
              {
                category_id: customCategory.id,
                value: JSON.stringify(raw_stress_data),
                entry_date: date,
                notes: 'Source: Garmin',
                source: 'garmin',
              }
            );
            processedResults.push({
              type: 'raw_stress_data',
              status: 'success',
              date,
            });
          } catch (error: unknown) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            log(
              'error',
              `Error storing raw stress data for user ${userId} on ${date}:`,
              errorMessage
            );
            errors.push({
              type: 'raw_stress_data',
              status: 'error',
              date,
              message: errorMessage,
            });
          }
        }
        // Store derived mood value
        if (derived_mood_value !== null && derived_mood_value !== undefined) {
          try {
            await moodRepository.createOrUpdateMoodEntry(
              userId,
              derived_mood_value,
              derived_mood_notes,
              date
            );
            processedResults.push({
              type: 'derived_mood_value',
              status: 'success',
              date,
            });
          } catch (error: unknown) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            log(
              'error',
              `Error storing derived mood value for user ${userId} on ${date}:`,
              errorMessage
            );
            errors.push({
              type: 'derived_mood_value',
              status: 'error',
              date,
              message: errorMessage,
            });
          }
        }
      }
    }
    // Add processing for other health metrics here as needed in the future
    // For example:
    // if (healthData.heart_rates && Array.isArray(healthData.heart_rates)) {
    //   for (const hrEntry of healthData.heart_rates) {
    //     // Process heart rate data
    // }
    // }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(
      'error',
      `[garminService] Unexpected error in processGarminHealthAndWellnessData for user ${userId}:`,
      errorMessage
    );
    errors.push({ type: 'general', status: 'error', message: errorMessage });
  }
  if (errors.length > 0) {
    throw new Error(
      JSON.stringify({
        message:
          'Some Garmin health and wellness data entries could not be processed.',
        processed: processedResults,
        errors: errors,
      })
    );
  } else {
    return {
      message: 'All Garmin health and wellness data successfully processed.',
      processed: processedResults,
    };
  }
}
// Helper function to process a Garmin workout session (e.g., Wokroutv2.txt)
async function processGarminWorkoutSession(
  userId: string,
  sessionData: GarminSessionData,
  startDate: string,
  endDate: string,
  timezone = 'UTC'
) {
  const { activity, exercise_sets } = sessionData;
  const workoutName = activity.activityName || 'Garmin Workout Session';
  const entryDate = (activity.startTimeLocal as string)
    ? (activity.startTimeLocal as string).substring(0, 10)
    : todayInZone(timezone);
  // Data from sessionData should already be parsed objects if coming from the microservice
  const details = sessionData.details || {};
  const activityDetailMetrics =
    (details.activityDetailMetrics as Record<string, unknown>[]) || [];
  // Find the index for heart rate in activityDetailMetrics
  const hrDesc = (
    activity.descriptors as Record<string, unknown>[] | undefined
  )?.find((desc: Record<string, unknown>) => desc.key === 'directHeartRate');
  const tsDesc = (
    activity.descriptors as Record<string, unknown>[] | undefined
  )?.find((desc: Record<string, unknown>) => desc.key === 'directTimestamp');
  const hrIndex = hrDesc ? (hrDesc.index as number) : -1;
  const timestampIndex = tsDesc ? (tsDesc.index as number) : -1;
  let workoutPreset = await workoutPresetRepository.getWorkoutPresetByName(
    userId,
    workoutName
  );
  const isNewWorkoutPreset = !workoutPreset;
  if (isNewWorkoutPreset) {
    workoutPreset = await workoutPresetRepository.createWorkoutPreset({
      user_id: userId,
      name: workoutName,
      description:
        activity.notes || `Workout session from Garmin: ${workoutName}`,
      is_public: false,
    });
  }
  const exercisePresetEntryData = {
    user_id: userId,
    workout_preset_id: workoutPreset.id,
    name: workoutName,
    description:
      (activity.notes as string) || `Logged session of ${workoutName}`,
    entry_date: entryDate,
    created_by_user_id: userId,
    notes: `Garmin Workout Session: ${workoutName}`,
    source: 'garmin', // Add source to exercise_preset_entries
    steps:
      (activity.steps as number) ||
      (activity.totalSteps as number) ||
      (activity.stepCount as number) ||
      0,
  };
  const newExercisePresetEntry =
    (await exercisePresetEntryRepository.createExercisePresetEntry(
      userId,
      exercisePresetEntryData,
      userId
    )) as Record<string, unknown>;
  await activityDetailsRepository.createActivityDetail(userId, {
    exercise_preset_entry_id: newExercisePresetEntry.id, // Link to preset entry
    provider_name: 'garmin',
    detail_type: 'full_activity_data',
    detail_data: sessionData,
    created_by_user_id: userId,
  });
  if (exercise_sets && Array.isArray(exercise_sets.exerciseSets)) {
    const groupedExercises: ExerciseGroup[] = [];
    let currentGroup: ExerciseGroup | null = null;
    let totalActiveDurationSeconds = 0;
    const activeSetsWithStartAndEndTimes = []; // Store active sets with their calculated start and end times
    // First pass to group sets by exercise and calculate total active duration
    for (let i = 0; i < exercise_sets.exerciseSets.length; i++) {
      const garminSet = exercise_sets.exerciseSets[i];
      // We need to look further ahead to find the next ACTIVE set for rest time calculation
      let garminExerciseName = null;
      let garminCategory = 'Uncategorized';
      if (
        garminSet.exercises &&
        (garminSet.exercises as unknown[]).length > 0
      ) {
        garminExerciseName =
          ((garminSet.exercises as Record<string, unknown>[])[0]
            .name as string) ||
          ((garminSet.exercises as Record<string, unknown>[])[0]
            .category as string);
        garminCategory =
          ((garminSet.exercises as Record<string, unknown>[])[0]
            .category as string) || 'Uncategorized';
      } else if (garminSet.category) {
        garminExerciseName = garminSet.category as string;
        garminCategory = garminSet.category as string;
      }
      // If we still don't have an exercise name (e.g. an unnamed REST or WARM_UP set),
      // inherit it from the current group to prevent breaking the exercise into multiple 1-set entries.
      // We ONLY inherit for non-ACTIVE sets. An ACTIVE set without a name is a new, unrecognized exercise.
      if (
        !garminExerciseName &&
        currentGroup &&
        garminSet.setType !== 'ACTIVE'
      ) {
        garminExerciseName = currentGroup.name;
        garminCategory =
          currentGroup.exerciseDetails.category || 'Uncategorized';
      } else if (!garminExerciseName) {
        garminExerciseName = 'Unknown Exercise';
      }
      if (garminExerciseName) {
        const exerciseName: string = (garminExerciseName as string)
          .replace(/_/g, ' ')
          .replace(/\b\w/g, (l: string) => l.toUpperCase());
        const stepIndex = garminSet.stepIndex || garminSet.wktStepId || null;
        if (
          !currentGroup ||
          currentGroup.name !== exerciseName ||
          (stepIndex !== null &&
            currentGroup.stepIndex !== null &&
            currentGroup.stepIndex !== stepIndex)
        ) {
          currentGroup = {
            name: exerciseName,
            stepIndex: stepIndex,
            exerciseDetails: { category: garminCategory },
            sets: [],
            totalDuration: 0,
            activeDuration: 0,
            startTime: null as number | null, // To store the start time of the first active set for this exercise
            endTime: null as number | null, // To store the end time of the last active set for this exercise
          };
          groupedExercises.push(currentGroup);
        }
        const setTypeMapping = {
          ACTIVE: 'Working Set',
          REST: 'Rest Set',
          WARM_UP: 'Warm-up Set',
          // Add other mappings as needed
        };
        const setType =
          (setTypeMapping as Record<string, string>)[garminSet.setType] ||
          'Working Set'; // Default to 'Working Set' if not mapped
        const durationSeconds = garminSet.duration
          ? Math.round(Number(garminSet.duration))
          : 0;
        const weightKg = garminSet.weight
          ? parseFloat((Number(garminSet.weight) * 0.001).toFixed(2))
          : 0; // Assuming weight is in grams, convert to kg and round to 2 decimal places
        if (garminSet.setType !== 'REST') {
          const currentSet = {
            set_number: currentGroup.sets.length + 1, // Incremental set number
            set_type: setType,
            reps: Math.round(Number(garminSet.repetitionCount || 0)),
            weight: weightKg,
            duration: Math.round(durationSeconds / 60),
            rest_time: 0, // Default rest time
            notes: garminSet.notes || '',
          };
          currentGroup.sets.push(currentSet);
          if (garminSet.setType === 'ACTIVE') {
            currentGroup.totalDuration += durationSeconds;
            currentGroup.activeDuration += durationSeconds;
            totalActiveDurationSeconds += durationSeconds;
            const setStartTime = new Date(
              garminSet.startTime as string | number | Date
            ).getTime(); // Convert to milliseconds
            const setEndTime = setStartTime + durationSeconds * 1000;
            if (
              !currentGroup.startTime ||
              setStartTime < (currentGroup.startTime as number)
            ) {
              currentGroup.startTime = setStartTime;
            }
            if (
              !currentGroup.endTime ||
              setEndTime > (currentGroup.endTime as number)
            ) {
              currentGroup.endTime = setEndTime;
            }
            // Store active set details for later rest time calculation
            activeSetsWithStartAndEndTimes.push({
              set: currentSet,
              startTime: setStartTime,
              endTime: setEndTime,
              garminSetIndex: i, // Store original index to find next active set
            });
          }
        } else {
          // It's a REST set, just add its duration to the group's total duration
          currentGroup.totalDuration += durationSeconds;
        }
      }
    }
    // Second pass to calculate rest times based on consecutive active sets
    for (let i = 0; i < activeSetsWithStartAndEndTimes.length; i++) {
      const currentActiveSetInfo = activeSetsWithStartAndEndTimes[i];
      const currentSet = currentActiveSetInfo.set;
      // Find the next active set in the original garmin exerciseSets array
      let nextActiveSetInfo = null;
      for (
        let j = currentActiveSetInfo.garminSetIndex + 1;
        j < exercise_sets.exerciseSets.length;
        j++
      ) {
        const potentialNextGarminSet = exercise_sets.exerciseSets[j];
        if (
          potentialNextGarminSet.setType === 'ACTIVE' &&
          potentialNextGarminSet.exercises &&
          potentialNextGarminSet.exercises.length > 0
        ) {
          // Found the next active set
          const nextSetStartTime = new Date(
            potentialNextGarminSet.startTime
          ).getTime();
          const nextSetDuration = potentialNextGarminSet.duration
            ? Math.round(potentialNextGarminSet.duration)
            : 0;
          nextActiveSetInfo = {
            startTime: nextSetStartTime,
            duration: nextSetDuration,
          };
          break;
        } else if (potentialNextGarminSet.setType === 'REST') {
          // If there's a REST set immediately following, and it has a duration, use that
          const restDuration = potentialNextGarminSet.duration
            ? Math.round(potentialNextGarminSet.duration)
            : 0;
          if (restDuration > 0) {
            currentSet.rest_time = restDuration;
            break; // Rest time assigned, move to next active set
          }
        }
      }
      if (nextActiveSetInfo) {
        const timeBetweenSets =
          (nextActiveSetInfo.startTime - currentActiveSetInfo.endTime) / 1000; // in seconds
        if (timeBetweenSets > 0) {
          currentSet.rest_time = Math.round(timeBetweenSets);
        }
      }
    }
    let exerciseSortOrder = 0;
    for (const group of groupedExercises) {
      const exerciseName = group.name;
      const {
        exerciseDetails,
        sets,
        totalDuration,
        activeDuration,
        startTime,
        endTime,
      } = group;
      let exercise = await exerciseRepository.findExerciseByNameAndUserId(
        exerciseName,
        userId
      );
      if (!exercise) {
        exercise = await exerciseRepository.createExercise({
          user_id: userId,
          name: exerciseName,
          category: exerciseDetails.category || 'Uncategorized',
          source: 'garmin',
          is_custom: true,
          shared_with_public: false,
          force: null,
          level: null,
          mechanic: null,
          equipment: null,
          primary_muscles: null,
          secondary_muscles: null,
          instructions: null,
          images: null,
        });
      }
      let perExerciseCaloriesBurned = 0;
      if (totalActiveDurationSeconds > 0 && activity.active_calories) {
        perExerciseCaloriesBurned =
          (activeDuration / totalActiveDurationSeconds) *
          ((activity.active_calories as number) || 0);
      }
      let perExerciseAvgHeartRate: number | null = null;
      if (hrIndex !== -1 && timestampIndex !== -1 && startTime && endTime) {
        let heartRateSum = 0;
        let heartRateCount = 0;
        for (const metric of activityDetailMetrics as Record<
          string,
          unknown
        >[]) {
          const metrics = metric.metrics as number[];
          const metricTimestamp = metrics[timestampIndex];
          const heartRate = metrics[hrIndex];
          // Garmin timestamps are in milliseconds, convert to seconds for comparison with startTime/endTime
          // startTime and endTime are already in milliseconds
          if (
            metricTimestamp >= (startTime as number) &&
            metricTimestamp <= (endTime as number) &&
            heartRate !== undefined &&
            heartRate !== null
          ) {
            heartRateSum += heartRate;
            heartRateCount++;
          }
        }
        if (heartRateCount > 0) {
          perExerciseAvgHeartRate = Math.round(heartRateSum / heartRateCount); // Round to nearest whole number
        }
      }
      const exerciseEntryData = {
        exercise_id: exercise.id,
        duration_minutes: totalDuration / 60, // Convert total seconds to minutes
        calories_burned: Math.round(perExerciseCaloriesBurned), // Round calories to nearest whole number
        entry_date: entryDate,
        notes: `Garmin Exercise: ${exerciseName}`,
        sets: sets,
        exercise_preset_entry_id: newExercisePresetEntry.id, // Link to preset entry
        avg_heart_rate: perExerciseAvgHeartRate
          ? Math.round(perExerciseAvgHeartRate as number)
          : null, // Round to nearest whole number or keep null
        source_id: activity.activityId
          ? `${activity.activityId as string}_${exerciseSortOrder}`
          : null,
        steps:
          (activity.steps as number) ||
          (activity.totalSteps as number) ||
          (activity.stepCount as number) ||
          0,
      };
      await exerciseEntryRepository.createExerciseEntry(
        userId,
        { ...exerciseEntryData, sort_order: exerciseSortOrder },
        userId,
        'garmin',
        newExercisePresetEntry.id as string
      );
      const existingExerciseInPreset = (
        workoutPreset.exercises as Record<string, unknown>[] | undefined
      )?.find((e: Record<string, unknown>) => e.exercise_id === exercise.id);
      if (isNewWorkoutPreset || !existingExerciseInPreset) {
        await workoutPresetRepository.addExerciseToWorkoutPreset(
          userId,
          workoutPreset.id,
          exercise.id,
          null, // image_url
          isNewWorkoutPreset ? sets : [], // Only add sets to the preset if it's a new preset
          exerciseSortOrder
        );
      }
      exerciseSortOrder++;
    }
  }
}
// Helper function to process a Garmin workout definition (e.g., workout training.txt)
async function processGarminWorkoutDefinition(
  userId: string,
  workoutData: GarminData
) {
  const workoutName = workoutData.workoutName || 'Garmin Workout Definition';
  const description =
    workoutData.description || `Workout definition from Garmin: ${workoutName}`;
  let workoutPreset = (await workoutPresetRepository.getWorkoutPresetByName(
    userId,
    workoutName
  )) as WorkoutPreset | null;
  if (!workoutPreset) {
    workoutPreset = (await workoutPresetRepository.createWorkoutPreset({
      user_id: userId,
      name: workoutName,
      description: description,
      is_public: false,
    })) as WorkoutPreset;
  }
  if (
    workoutData.workoutSegments &&
    Array.isArray(workoutData.workoutSegments)
  ) {
    let exerciseSortOrder = 0;
    for (const segment of workoutData.workoutSegments as Record<
      string,
      unknown
    >[]) {
      if (segment.workoutSteps && Array.isArray(segment.workoutSteps)) {
        for (const step of segment.workoutSteps as Record<string, unknown>[]) {
          const stepsToProcess =
            step.type === 'RepeatGroupDTO'
              ? (step.workoutSteps as Record<string, unknown>[])
              : [step];
          for (const individualStep of stepsToProcess) {
            if (
              individualStep.type === 'ExecutableStepDTO' &&
              individualStep.exerciseName
            ) {
              const garminExerciseName = individualStep.exerciseName as string;
              const exerciseName = garminExerciseName
                .replace(/_/g, ' ')
                .replace(/\b\w/g, (l: string) => l.toUpperCase());
              let exercise =
                await exerciseRepository.findExerciseByNameAndUserId(
                  exerciseName,
                  userId
                );
              if (!exercise) {
                exercise = await exerciseRepository.createExercise({
                  user_id: userId,
                  name: exerciseName,
                  category:
                    (individualStep.category as string) || 'Uncategorized',
                  source: 'garmin',
                  is_custom: true,
                  shared_with_public: false,
                });
              }
              const stepType = individualStep.stepType as
                | Record<string, unknown>
                | undefined;
              const sets = [
                {
                  set_number: 1,
                  set_type: stepType?.stepTypeKey as string,
                  reps: (individualStep.endConditionValue as number) || 0,
                  weight: individualStep.weightValue
                    ? (individualStep.weightValue as number) * 0.453592
                    : 0, // Assuming weight is in pounds, convert to kg
                  duration: 0,
                  rest_time: 0,
                  notes: (individualStep.description as string) || '',
                },
              ];
              await workoutPresetRepository.addExerciseToWorkoutPreset(
                userId,
                workoutPreset.id,
                exercise.id,
                null,
                sets,
                exerciseSortOrder
              );
              exerciseSortOrder++;
            }
          }
        }
      }
    }
  }
}
// Helper function to process a simple Garmin activity
async function processGarminSimpleActivity(
  userId: string,
  activityData: GarminSessionData,
  timezone = 'UTC'
) {
  const { activity } = activityData;
  const activityType = activity.activityType as
    | Record<string, unknown>
    | undefined;
  const activityTypeKey = activityType?.typeKey as string | undefined;
  const exerciseName = activityTypeKey
    ? activityTypeKey
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (l: string) => l.toUpperCase())
    : 'Garmin Activity';
  let exercise = await exerciseRepository.findExerciseByNameAndUserId(
    exerciseName,
    userId
  );
  if (!exercise) {
    exercise = await exerciseRepository.createExercise({
      user_id: userId,
      name: exerciseName,
      category: activityTypeKey || 'Uncategorized',
      source: 'garmin',
      is_custom: true,
      shared_with_public: false,
    });
  }
  const entryDate = (activity.startTimeLocal as string)
    ? (activity.startTimeLocal as string).substring(0, 10)
    : todayInZone(timezone);
  const exerciseEntryData = {
    exercise_id: exercise.id,
    duration_minutes: ((activity.duration as number) || 0) / 60,
    calories_burned: Math.round(
      ((activity.active_calories as number) || 0) +
        ((activity.bmr_calories as number) || 0)
    ),
    entry_date: entryDate,
    notes: `Garmin Activity: ${activity.activityName as string} (${activityTypeKey || 'Garmin'})`,
    distance: activity.distance as number | undefined,
    avg_heart_rate:
      (activity.averageHR as number) ||
      (activity.averageHeartRateInBeatsPerMinute as number) ||
      null,
    source_id: (activity.activityId as string | number)?.toString() ?? null,
    steps:
      (activity.steps as number) ||
      (activity.totalSteps as number) ||
      (activity.stepCount as number) ||
      0,
  };
  const newEntry = await exerciseEntryRepository.createExerciseEntry(
    userId,
    exerciseEntryData,
    userId,
    'garmin'
  );
  await activityDetailsRepository.createActivityDetail(userId, {
    exercise_entry_id: newEntry.id,
    provider_name: 'garmin',
    detail_type: 'full_activity_data',
    detail_data: {
      activity: activityData.activity,
      details: activityData.details || {
        activityDetailMetrics: [],
        metricDescriptors: [],
      },
      splits: activityData.splits || { lapDTOs: [] },
      hr_in_timezones: activityData.hr_in_timezones || [],
    },
    created_by_user_id: userId,
  });
}
async function processGarminSleepData(
  userId: string,
  actingUserId: string,
  sleepDataArray: any[],
  startDate: string,
  endDate: string
) {
  const processedResults = [];
  const errors = [];
  // Comprehensive cleanup for Garmin-sourced sleep data for the date range
  log(
    'info',
    `[garminService] Performing comprehensive cleanup for Garmin sleep data for user ${userId} from ${startDate} to ${endDate}.`
  );
  await sleepRepository.deleteSleepEntriesByEntrySourceAndDate(
    userId,
    'garmin',
    startDate,
    endDate
  );
  for (const sleepEntry of sleepDataArray) {
    try {
      const result = await measurementService.processSleepEntry(
        userId,
        actingUserId,
        sleepEntry
      );
      processedResults.push({ status: 'success', data: result });
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log(
        'error',
        `Error processing Garmin sleep entry for user ${userId}:`,
        errorMessage
      );
      errors.push({
        status: 'error',
        message: errorMessage,
        entry: sleepEntry,
      });
    }
  }
  if (errors.length > 0) {
    throw new Error(
      JSON.stringify({
        message: 'Some Garmin sleep entries could not be processed.',
        processed: processedResults,
        errors: errors,
      })
    );
  } else {
    return {
      message: 'All Garmin sleep data successfully processed.',
      processed: processedResults,
    };
  }
}

async function syncGarminHydration(
  userId: string,
  date: string,
  isManualTrigger = false
) {
  log(
    'info',
    `[WATER_SYNC] Syncing hydration for user ${userId} on ${date} (Manual trigger: ${isManualTrigger})`
  );

  try {
    // 1. Get current hydration state from Garmin
    const garminState = await garminConnectService.getGarminHydrationData(
      userId,
      date
    );
    if (!garminState) {
      log(
        'warn',
        `[WATER_SYNC] No hydration data returned from Garmin for ${date}`
      );
      return;
    }

    const {
      goalInML,
      valueInML: garminValueInML,
      userProfileId,
      sweatLossInML,
    } = garminState;

    // 2. Update SparkyFitness goal if it has changed from Garmin's goal
    const currentGoals = await goalService.getUserGoals(userId, date);
    if (
      currentGoals &&
      goalInML &&
      Math.abs(currentGoals.water_goal_ml - goalInML) > 1
    ) {
      log(
        'info',
        `[WATER_SYNC] Updating hydration goal for user ${userId} on ${date}: ${currentGoals.water_goal_ml} -> ${goalInML} mL (Sweat loss: ${sweatLossInML} mL)`
      );

      // We use currentGoals as a template but only update specific fields
      const goalPayload = {
        ...currentGoals,
        user_id: userId,
        goal_date: date,
        water_goal_ml: goalInML,
      };

      // Remove unwanted metadata fields
      delete goalPayload.id;
      delete (goalPayload as any).created_at;
      delete (goalPayload as any).updated_at;

      await goalRepository.upsertGoal(goalPayload);
    }

    // 3. Sync water intake
    // We treat 'manual' and 'mfp' sources as the User's Intent.
    // We treat 'garmin' source in Sparky as the Mirror of what's already on the watch.
    const client = await poolManager.getClient(userId);
    let sparkyIntentML = 0;
    try {
      const result = await client.query(
        "SELECT SUM(water_ml) as total FROM water_intake WHERE user_id = $1 AND entry_date = $2 AND source IN ('manual', 'mfp')",
        [userId, date]
      );
      sparkyIntentML = Math.round(Number(result.rows[0]?.total || 0));
    } finally {
      client.release();
    }

    if (sparkyIntentML === 0 && garminValueInML > 0 && !isManualTrigger) {
      // CASE A: Background sync and no manual logs in Sparky.
      // ACTION: Import from Garmin watch to Sparky (assume user logged on watch first).
      log(
        'info',
        `[WATER_SYNC] Background Import: ${garminValueInML} mL from watch to Sparky for user ${userId} on ${date}`
      );
      await measurementRepository.upsertWaterData(
        userId,
        userId,
        garminValueInML,
        date,
        'garmin'
      );
    } else {
      // CASE B: Manual trigger or Sparky has logs.
      // ACTION: Sparky is Master. Make Garmin match Sparky's INTENTIONAL total (even if 0).
      const diffML = Math.round(sparkyIntentML - garminValueInML);

      if (Math.abs(diffML) > 10) {
        log(
          'info',
          `[WATER_SYNC] Exporting to Garmin: ${diffML} mL diff for user ${userId} on ${date} (Intent: ${sparkyIntentML} mL, Watch: ${garminValueInML} mL)`
        );
        await garminConnectService.logGarminHydration(userId, date, diffML, {
          userProfileId,
        });
      }

      // CRITICAL: Once Sparky Intent is established, we must ensure there's no duplicate
      // 'garmin' bucket entry that would inflate the total when summed.
      const clientCleanup = await poolManager.getClient(userId);
      try {
        await clientCleanup.query(
          "DELETE FROM water_intake WHERE user_id = $1 AND entry_date = $2 AND source = 'garmin'",
          [userId, date]
        );
      } finally {
        clientCleanup.release();
      }
    }
  } catch (err: any) {
    log(
      'error',
      `[WATER_SYNC] Error in syncGarminHydration for user ${userId}:`,
      err.message
    );
  }
}

async function syncGarminData(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  userId: any,
  syncType = 'manual',
  customStartDate: string | null = null,
  customEndDate: string | null = null
) {
  let startDate, endDate;
  const tz = await loadUserTimezone(userId);
  const today = todayInZone(tz);
  if (customStartDate) {
    startDate = customStartDate;
    endDate = customEndDate || today;
  } else if (syncType === 'manual') {
    endDate = today;
    startDate = addDays(today, -7);
  } else if (syncType === 'scheduled') {
    endDate = today;
    startDate = today;
  } else {
    throw new Error("Invalid syncType. Must be 'manual' or 'scheduled'.");
  }

  // Hydration sync (only for the end date / today)
  try {
    await syncGarminHydration(userId, endDate);
  } catch (err) {
    log(
      'error',
      `[garminService] Failed to sync Garmin hydration for user ${userId} on ${endDate}:`,
      err
    );
  }

  log(
    'info',
    `[garminService] Starting Garmin sync (${syncType}) for user ${userId} from ${startDate} to ${endDate}.`
  );
  const results: any = {
    health: null,
    activities: null,
  };
  // Phase 1: Health and Wellness — runs independently so a failure here does not skip activities
  try {
    // 1. Sync Health and Wellness
    log('info', '[garminService] Fetching Health and Wellness data...');
    const healthWellnessData =
      await garminConnectService.syncGarminHealthAndWellness(
        userId,
        startDate,
        endDate,
        []
      );
    // 2. Process Health and Wellness (Stress, Mood, etc.)
    const processedGarminHealthData = await processGarminHealthAndWellnessData(
      userId,
      userId,
      healthWellnessData.data,
      startDate,
      endDate
    );
    // 3. Map and Process other Health Metrics (Steps, Weight, etc.)
    const processedHealthData = [];
    for (const metric in healthWellnessData.data) {
      if (metric === 'stress') continue; // Already processed
      const dailyEntries = healthWellnessData.data[metric];
      if (Array.isArray(dailyEntries)) {
        for (const entry of dailyEntries) {
          const calendarDateRaw = entry.date;
          if (!calendarDateRaw) continue;
          const calendarDate = moment(calendarDateRaw).format('YYYY-MM-DD');
          for (const key in entry) {
            if (key === 'date') continue;
            // @ts-expect-error TS(7053): Element implicitly has an 'any' type because expre... Remove this comment to see the full error message
            let mapping = garminMeasurementMapping[key];
            if (!mapping && key === 'value') {
              // @ts-expect-error TS(7053): Element implicitly has an 'any' type because expre... Remove this comment to see the full error message
              mapping = garminMeasurementMapping[metric];
            }
            if (mapping) {
              const value = entry[key];
              if (value === null || value === undefined) continue;
              const type =
                mapping.targetType === 'check_in'
                  ? mapping.field
                  : mapping.name;
              processedHealthData.push({
                type: type,
                value: value,
                date: calendarDate,
                source: 'garmin',
                dataType: mapping.dataType,
                measurementType: mapping.measurementType,
              });
            }
          }
        }
      }
    }
    let measurementServiceResult = {};
    if (processedHealthData.length > 0) {
      measurementServiceResult = await measurementService.processHealthData(
        processedHealthData,
        userId,
        userId
      );
    }
    // 4. Process Sleep
    let processedSleepData = {};
    if (
      healthWellnessData.data &&
      healthWellnessData.data.sleep &&
      healthWellnessData.data.sleep.length > 0
    ) {
      processedSleepData = await processGarminSleepData(
        userId,
        userId,
        healthWellnessData.data.sleep,
        startDate,
        endDate
      );
    }
    results.health = {
      processedGarminHealthData,
      measurementServiceResult,
      processedSleepData,
    };
  } catch (healthError: any) {
    log(
      'error',
      `[garminService] Error during health sync for user ${userId}:`,
      healthError
    );
    results.health = {
      error:
        healthError instanceof Error
          ? healthError.message
          : String(healthError),
    };
  }
  // Phase 2: Activities and Workouts — always runs even if Phase 1 failed
  try {
    // 5. Sync Activities and Workouts
    log('info', '[garminService] Fetching Activities and Workouts data...');
    const activitiesData =
      await garminConnectService.fetchGarminActivitiesAndWorkouts(
        userId,
        startDate,
        endDate
      );
    // 6. Process Activities and Workouts
    const processedActivities = await processActivitiesAndWorkouts(
      userId,
      activitiesData,
      startDate,
      endDate,
      tz
    );
    results.activities = processedActivities;
  } catch (activitiesError: any) {
    log(
      'error',
      `[garminService] Error during activities sync for user ${userId}:`,
      activitiesError
    );
    results.activities = {
      error:
        activitiesError instanceof Error
          ? activitiesError.message
          : String(activitiesError),
    };
  }
  log('info', `[garminService] Full Garmin sync completed for user ${userId}.`);
  return results;
}

export {
  processActivitiesAndWorkouts,
  processGarminWorkoutSession,
  processGarminWorkoutDefinition,
  processGarminSimpleActivity,
  processGarminSleepData,
  processGarminHealthAndWellnessData,
  syncGarminData,
  syncGarminHydration,
};

export default {
  processActivitiesAndWorkouts,
  processGarminWorkoutSession,
  processGarminWorkoutDefinition,
  processGarminSimpleActivity,
  processGarminSleepData,
  processGarminHealthAndWellnessData,
  syncGarminData,
  syncGarminHydration,
};
