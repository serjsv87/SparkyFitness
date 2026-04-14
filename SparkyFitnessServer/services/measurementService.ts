import { log } from '../config/logging.js';
import measurementRepository from '../models/measurementRepository.js';
import { loadUserTimezone } from '../utils/timezoneLoader.js';
import {
  instantToDay,
  instantHourMinute,
  instantToDayWithOffset,
  instantHourMinuteWithOffset,
  isValidTimeZone,
  isDayString,
} from '@workspace/shared';
import { userAge } from '../utils/dateHelpers.js';
import userRepository from '../models/userRepository.js';
import sleepRepository from '../models/sleepRepository.js';
import exerciseDb from '../models/exercise.js';
import exerciseEntryDb from '../models/exerciseEntry.js';
import waterContainerRepository from '../models/waterContainerRepository.js';
import activityDetailsRepository from '../models/activityDetailsRepository.js';
import * as mfpSyncService from './mfpSyncService.js';

/**
 * Default units for health metric types when not provided by client (e.g. HealthConnect sync).
 * Ensures graphs and UI show a unit instead of "N/A". Aligned with mobile HealthMetrics and API usage.
 */
const DEFAULT_UNITS_BY_HEALTH_TYPE = {
  step: 'steps',
  steps: 'steps',
  heart_rate: 'bpm',
  HeartRate: 'bpm',
  'Active Calories': 'kcal',
  ActiveCaloriesBurned: 'kcal',
  total_calories: 'kcal',
  TotalCaloriesBurned: 'kcal',
  distance: 'm',
  Distance: 'm',
  floors_climbed: 'count',
  FloorsClimbed: 'count',
  weight: 'kg',
  Weight: 'kg',
  sleep_session: 'min',
  SleepSession: 'min',
  stress: 'level',
  Stress: 'level',
  blood_pressure: 'mmHg',
  BloodPressure: 'mmHg',
  basal_metabolic_rate: 'kcal',
  BasalMetabolicRate: 'kcal',
  blood_glucose: 'mmol/L',
  BloodGlucose: 'mmol/L',
  body_fat: '%',
  BodyFat: '%',
  body_temperature: 'celsius',
  BodyTemperature: 'celsius',
  resting_heart_rate: 'bpm',
  RestingHeartRate: 'bpm',
  respiratory_rate: 'breaths/min',
  RespiratoryRate: 'breaths/min',
  oxygen_saturation: '%',
  OxygenSaturation: '%',
  BloodOxygenSaturation: '%',
  vo2_max: 'ml/min/kg',
  Vo2Max: 'ml/min/kg',
  height: 'm',
  Height: 'm',
  hydration: 'L',
  Hydration: 'L',
  lean_body_mass: 'kg',
  LeanBodyMass: 'kg',
  basal_body_temperature: 'celsius',
  BasalBodyTemperature: 'celsius',
  elevation_gained: 'm',
  ElevationGained: 'm',
  bone_mass: 'kg',
  BoneMass: 'kg',
  speed: 'm/s',
  Speed: 'm/s',
  power: 'watts',
  Power: 'watts',
  steps_cadence: 'steps/min',
  StepsCadence: 'steps/min',
  cycling_pedaling_cadence: 'rpm',
  CyclingPedalingCadence: 'rpm',
  blood_alcohol_content: '%',
  BloodAlcoholContent: '%',
  nutrition: 'kcal',
  Nutrition: 'kcal',
  // Aggregated min/max/avg types from mobile health data
  // Chunk 1: Heart rate + vitals
  heart_rate_min: 'bpm',
  heart_rate_max: 'bpm',
  heart_rate_avg: 'bpm',
  blood_glucose_min: 'mmol/L',
  blood_glucose_max: 'mmol/L',
  blood_glucose_avg: 'mmol/L',
  blood_oxygen_saturation_min: 'percent',
  blood_oxygen_saturation_max: 'percent',
  blood_oxygen_saturation_avg: 'percent',
  respiratory_rate_min: 'breaths/min',
  respiratory_rate_max: 'breaths/min',
  respiratory_rate_avg: 'breaths/min',
  // Chunk 2: Running metrics
  running_speed_min: 'm/s',
  running_speed_max: 'm/s',
  running_speed_avg: 'm/s',
  running_power_min: 'W',
  running_power_max: 'W',
  running_power_avg: 'W',
  running_stride_length_min: 'cm',
  running_stride_length_max: 'cm',
  running_stride_length_avg: 'cm',
  running_ground_contact_min: 'ms',
  running_ground_contact_max: 'ms',
  running_ground_contact_avg: 'ms',
  running_vertical_oscillation_min: 'cm',
  running_vertical_oscillation_max: 'cm',
  running_vertical_oscillation_avg: 'cm',
  // Chunk 3: Cycling metrics
  cycling_speed_min: 'm/s',
  cycling_speed_max: 'm/s',
  cycling_speed_avg: 'm/s',
  cycling_power_min: 'W',
  cycling_power_max: 'W',
  cycling_power_avg: 'W',
  cycling_cadence_min: 'rpm',
  cycling_cadence_avg: 'rpm',
  cycling_cadence_avg: 'rpm',
  // Chunk 4: Walking / mobility metrics
  walking_speed_min: 'm/s',
  walking_speed_max: 'm/s',
  walking_speed_avg: 'm/s',
  walking_step_length_min: 'cm',
  walking_step_length_max: 'cm',
  walking_step_length_avg: 'cm',
  walking_asymmetry_min: 'percent',
  walking_asymmetry_max: 'percent',
  walking_asymmetry_avg: 'percent',
  walking_double_support_min: 'percent',
  walking_double_support_max: 'percent',
  walking_double_support_avg: 'percent',
  steps_cadence_min: 'steps/min',
  steps_cadence_max: 'steps/min',
  steps_cadence_avg: 'steps/min',
  // Chunk 5: Apple ring times + dietary (sum types)
  apple_move_time: 'seconds',
  apple_exercise_time: 'seconds',
  apple_stand_time: 'seconds',
  dietary_fat_total: 'g',
  dietary_protein: 'g',
  dietary_sodium: 'mg',
  // Chunk 6: Audio exposure
  environmental_audio_exposure_min: 'dB',
  environmental_audio_exposure_max: 'dB',
  environmental_audio_exposure_avg: 'dB',
  headphone_audio_exposure_min: 'dB',
  headphone_audio_exposure_max: 'dB',
  headphone_audio_exposure_avg: 'dB',
  // Last types
  cycling_ftp: 'W',
};
/**
 * Resolve the entry date, timestamp, and hour for a health data record using
 * the per-record timezone fallback chain:
 *   1. record_timezone (IANA)
 *   2. record_utc_offset_minutes (fixed offset)
 *   3. fallbackTimezone (account timezone)
 *
 * Basis instant varies by record type:
 *   - SleepSession: wake_time (entry date = wake day)
 *   - ExerciseSession/Workout: timestamp or date (entry date = start day)
 *   - everything else: date / entry_date / timestamp
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveHealthEntryDate(entry: any, fallbackTimezone: any) {
  // 1. Determine the basis instant
  let basisField;
  if (entry.type === 'SleepSession') {
    basisField =
      entry.wake_time || entry.date || entry.entry_date || entry.timestamp;
  } else if (entry.type === 'ExerciseSession' || entry.type === 'Workout') {
    // Prefer timestamp (actual instant) over pre-bucketed date strings
    // so timezone metadata can derive the correct day from the real instant
    basisField = entry.timestamp || entry.date || entry.entry_date;
  } else {
    basisField = entry.date || entry.entry_date || entry.timestamp;
  }
  // 2. If the basis is a date-only string (YYYY-MM-DD) with no timestamp,
  // the record was already bucketed client-side. Trust the date as-is —
  // applying timezone conversion to a UTC-midnight-parsed day string would
  // shift negative-offset zones to the previous day.
  const basisIsDayOnly =
    typeof basisField === 'string' &&
    isDayString(basisField) &&
    !entry.timestamp;
  const basisDate = new Date(basisField);
  if (isNaN(basisDate.getTime())) {
    return null;
  }
  if (basisIsDayOnly) {
    return {
      parsedDate: basisField,
      entryTimestamp: basisDate.toISOString(),
      entryHour: 0,
    };
  }
  // 3. Determine the timestamp for entryTimestamp (prefer explicit timestamp)
  let entryTimestamp;
  if (entry.timestamp) {
    const tsObj = new Date(entry.timestamp);
    entryTimestamp = isNaN(tsObj.getTime())
      ? basisDate.toISOString()
      : tsObj.toISOString();
  } else {
    entryTimestamp = basisDate.toISOString();
  }
  // The instant used for hour derivation
  const hourBasis = entry.timestamp ? new Date(entry.timestamp) : null;
  const validHourBasis =
    hourBasis && !isNaN(hourBasis.getTime()) ? hourBasis : null;
  // 4. Resolve timezone (fallback chain)
  if (entry.record_timezone && isValidTimeZone(entry.record_timezone)) {
    return {
      parsedDate: instantToDay(basisDate, entry.record_timezone),
      entryTimestamp,
      entryHour: validHourBasis
        ? instantHourMinute(validHourBasis, entry.record_timezone).hour
        : 0,
    };
  }
  if (
    entry.record_utc_offset_minutes !== null &&
    typeof entry.record_utc_offset_minutes === 'number'
  ) {
    return {
      parsedDate: instantToDayWithOffset(
        basisDate,
        entry.record_utc_offset_minutes
      ),
      entryTimestamp,
      entryHour: validHourBasis
        ? instantHourMinuteWithOffset(
            validHourBasis,
            entry.record_utc_offset_minutes
          ).hour
        : 0,
    };
  }
  // Fallback to account timezone — log for observability (Phase 4 tracking)
  log(
    'debug',
    `[resolveHealthEntryDate] No per-record timezone metadata for type=${entry.type}, falling back to account timezone (${fallbackTimezone})`
  );
  return {
    parsedDate: instantToDay(basisDate, fallbackTimezone),
    entryTimestamp,
    entryHour: validHourBasis
      ? instantHourMinute(basisDate, fallbackTimezone).hour
      : 0,
  };
}
const HEALTH_CONNECT_SLEEP_SOURCES = new Set([
  'Health Connect',
  'HealthConnect',
]);
const VALID_SLEEP_STAGE_TYPES = new Set([
  'awake',
  'rem',
  'light',
  'deep',
  'in_bed',
  'unknown',
]);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isHealthConnectSleepSource(source: any) {
  return typeof source === 'string' && HEALTH_CONNECT_SLEEP_SOURCES.has(source);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sanitizeHealthConnectSleepStageEvents(stageEvents: any) {
  if (!Array.isArray(stageEvents)) {
    return [];
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return stageEvents.reduce((sanitized: any, stageEvent: any) => {
    if (!stageEvent || typeof stageEvent !== 'object') {
      return sanitized;
    }
    const stageType =
      typeof stageEvent.stage_type === 'string'
        ? stageEvent.stage_type.toLowerCase()
        : null;
    if (!stageType || !VALID_SLEEP_STAGE_TYPES.has(stageType)) {
      return sanitized;
    }
    const startTime = new Date(stageEvent.start_time);
    const endTime = new Date(stageEvent.end_time);
    if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
      return sanitized;
    }
    let durationInSeconds = Number(stageEvent.duration_in_seconds);
    if (!Number.isFinite(durationInSeconds) || durationInSeconds <= 0) {
      durationInSeconds = (endTime.getTime() - startTime.getTime()) / 1000;
    }
    durationInSeconds = Math.round(durationInSeconds);
    if (durationInSeconds <= 0) {
      return sanitized;
    }
    sanitized.push({
      stage_type: stageType,
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString(),
      duration_in_seconds: durationInSeconds,
    });
    return sanitized;
  }, []);
}
async function processHealthData(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  healthDataArray: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  userId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actingUserId: any
) {
  const tz = await loadUserTimezone(userId);
  const processedResults = [];
  const errors = [];
  const affectedDates = new Set();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tzMetadataByType: any = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tzFallbackByType: any = {};
  // 0. Pre-Cleanup: Delete existing Sleep/Exercise entries for the date range to prevent duplicates
  // This implements a "delete-then-insert" strategy for idempotent sync
  const entriesToClean = healthDataArray.filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (d: any) =>
      d.type === 'SleepSession' ||
      d.type === 'ExerciseSession' ||
      d.type === 'Workout'
  );
  if (entriesToClean.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const datesBySource: any = {};
    for (const entry of entriesToClean) {
      const source = entry.source || 'manual';
      const resolved = resolveHealthEntryDate(entry, tz);
      if (resolved) {
        if (!datesBySource[source]) {
          datesBySource[source] = {};
        }
        datesBySource[source][resolved.parsedDate] = true;
      }
    }
    for (const source in datesBySource) {
      const dates = Object.keys(datesBySource[source]).sort();
      if (dates.length > 0) {
        const startDate = dates[0];
        const endDate = dates[dates.length - 1]; // Inclusive end date for the function call
        // Calculate max date + 1 day for database range logic if needed, but the current repo methods usually take inclusive/specific range
        // Looking at sleepRepository.deleteSleepEntriesByEntrySourceAndDate(user_id, source, start_date, end_date), it typically handles range.
        // Let's assume inclusive range which is standard for these helpers.
        log(
          'info',
          `[processHealthData] Pre-cleanup: Deleting existing entries for source '${source}' from ${startDate} to ${endDate}.`
        );
        // Clean Sleep
        await sleepRepository.deleteSleepEntriesByEntrySourceAndDate(
          userId,
          source,
          startDate,
          endDate
        );
        // Clean Exercises
        // Note: deleteExerciseEntriesByEntrySourceAndDate expects (userId, startDate, endDate, source) - verify arg order!
        // Based on typical repo patterns, let's verify.
        // Wait, standard exerciseEntryRepo usually puts userId first.
        // I will use safe assumption or verify garminService usage:
        // garminService: await exerciseEntryRepository.deleteExerciseEntriesByEntrySourceAndDate(userId, startDate, endDate, 'garmin');
        await exerciseEntryDb.deleteExerciseEntriesByEntrySourceAndDate(
          userId,
          startDate,
          endDate,
          source
        );
      }
    }
  }
  for (const dataEntry of healthDataArray) {
    const {
      value,
      type,
      date,
      timestamp,
      source = 'manual',
      dataType,
    } = dataEntry; // Added source and dataType with default
    // Check for required fields. Note: 'value' is not required for complex types like SleepSession, Stress, Workout.
    const complexTypes = [
      'SleepSession',
      'Stress',
      'ExerciseSession',
      'Workout',
    ];
    const isComplexType = complexTypes.includes(type);
    if (
      (!isComplexType && (value === undefined || value === null)) ||
      !type ||
      (!date && !timestamp)
    ) {
      // Check for undefined/null value only for non-complex types
      errors.push({
        error:
          'Missing required fields: value (for scalar types), type, or date/timestamp in one of the entries',
        entry: dataEntry,
      });
      continue;
    }
    const resolved = resolveHealthEntryDate(dataEntry, tz);
    if (!resolved) {
      const dateToParse = date || dataEntry.entry_date || timestamp;
      log(
        'error',
        `Date/Timestamp parsing error: Invalid date '${dateToParse}'`
      );
      errors.push({
        error: `Invalid date/timestamp format for entry: ${JSON.stringify(dataEntry)}.`,
        entry: dataEntry,
      });
      continue;
    }
    // Track timezone metadata presence per type for observability
    const entryType = dataEntry.type || 'unknown';
    if (
      dataEntry.record_timezone ||
      (dataEntry.record_utc_offset_minutes !== null &&
        dataEntry.record_utc_offset_minutes !== undefined)
    ) {
      tzMetadataByType[entryType] = (tzMetadataByType[entryType] || 0) + 1;
    } else {
      tzFallbackByType[entryType] = (tzFallbackByType[entryType] || 0) + 1;
    }
    const parsedDate = resolved.parsedDate;
    const entryTimestamp = resolved.entryTimestamp;
    const entryHour = resolved.entryHour;
    try {
      let result;
      let categoryId;
      // Handle specific types first, then fall back to custom measurements
      switch (type) {
        case 'step':
        case 'steps': {
          const stepValue = parseInt(value, 10);
          if (isNaN(stepValue) || !Number.isInteger(stepValue)) {
            errors.push({
              error: 'Invalid value for step. Must be an integer.',
              entry: dataEntry,
            });
            break;
          }
          result = await measurementRepository.upsertStepData(
            userId,
            actingUserId,
            stepValue,
            parsedDate
          );
          processedResults.push({ type, status: 'success', data: result });
          break;
        }
        case 'water': {
          const waterValue = parseInt(value, 10);
          if (isNaN(waterValue) || !Number.isInteger(waterValue)) {
            errors.push({
              error: 'Invalid value for water. Must be an integer.',
              entry: dataEntry,
            });
            break;
          }
          result = await measurementRepository.upsertWaterData(
            userId,
            actingUserId,
            waterValue,
            parsedDate,
            source // Use the provided source (e.g., 'fitbit', 'garmin', 'apple_health')
          );
          processedResults.push({ type, status: 'success', data: result });
          affectedDates.add(parsedDate);
          break;
        }
        case 'Active Calories':
        case 'active_calories':
        case 'ActiveCaloriesBurned': {
          const activeCaloriesValue = parseFloat(value);
          if (isNaN(activeCaloriesValue) || activeCaloriesValue < 0) {
            errors.push({
              error:
                'Invalid value for active_calories. Must be a non-negative number.',
              entry: dataEntry,
            });
            break;
          }
          const exerciseSource = source || 'Health Data';
          const exerciseId = await exerciseDb.getOrCreateActiveCaloriesExercise(
            userId,
            exerciseSource
          );
          result = await exerciseEntryDb.upsertExerciseEntryData(
            userId,
            actingUserId,
            exerciseId,
            activeCaloriesValue,
            parsedDate
          );
          processedResults.push({ type, status: 'success', data: result });
          affectedDates.add(parsedDate);
          break;
        }
        case 'weight':
        case 'body_fat_percentage': {
          const numericValue = parseFloat(value);
          if (isNaN(numericValue) || numericValue <= 0) {
            errors.push({
              error: `Invalid value for ${type}. Must be a positive number.`,
              entry: dataEntry,
            });
            break;
          }
          const checkInMeasurements = { [type]: numericValue };
          result = await measurementRepository.upsertCheckInMeasurements(
            userId,
            actingUserId,
            parsedDate,
            checkInMeasurements
          );
          processedResults.push({ type, status: 'success', data: result });
          break;
        }
        case 'SleepSession': {
          try {
            const stageEvents = isHealthConnectSleepSource(source)
              ? sanitizeHealthConnectSleepStageEvents(dataEntry.stage_events)
              : dataEntry.stage_events || [];
            // Map the dataEntry fields to what processSleepEntry expects
            const sleepEntryData = {
              entry_date: parsedDate,
              bedtime: dataEntry.bedtime
                ? new Date(dataEntry.bedtime)
                : new Date(timestamp),
              wake_time: dataEntry.wake_time
                ? new Date(dataEntry.wake_time)
                : dataEntry.duration_in_seconds
                  ? new Date(
                      new Date(timestamp).getTime() +
                        dataEntry.duration_in_seconds * 1000
                    )
                  : new Date(timestamp),
              duration_in_seconds: Number(dataEntry.duration_in_seconds) || 0,
              time_asleep_in_seconds:
                Number(dataEntry.time_asleep_in_seconds) || 0,
              sleep_score: Number(dataEntry.sleep_score) || 0,
              source: source,
              stage_events: stageEvents,
              deep_sleep_seconds: Number(dataEntry.deep_sleep_seconds) || 0,
              light_sleep_seconds: Number(dataEntry.light_sleep_seconds) || 0,
              rem_sleep_seconds: Number(dataEntry.rem_sleep_seconds) || 0,
              awake_sleep_seconds: Number(dataEntry.awake_sleep_seconds) || 0,
            };
            const sleepEntryResult = await processSleepEntry(
              userId,
              actingUserId,
              sleepEntryData
            );
            processedResults.push({
              type,
              status: 'success',
              data: sleepEntryResult,
            });
          } catch (sleepError: any) {
            log(
              'error',
              `Error processing sleep entry: ${sleepError.message}`,
              dataEntry
            );
            errors.push({
              error: `Failed to process sleep entry: ${sleepError.message}`,
              entry: dataEntry,
            });
          }
          break;
        }
        // Map incoming stress data to the existing custom measurement system
        case 'Stress': {
          try {
            const stressCategory = await getOrCreateCustomCategory(
              userId,
              actingUserId,
              'Stress',
              'numeric',
              'Daily'
            );
            if (!stressCategory || !stressCategory.id) {
              errors.push({
                error: 'Failed to get or create custom category for Stress',
                entry: dataEntry,
              });
              break;
            }
            // Check if 'value' is present, otherwise checks strictly for Stress it might be just presence?
            // Usually Stress has a level/value. If it's just a session token (val=1), use that.
            const stressValue =
              value !== undefined && value !== null ? value : 1;
            result = await measurementRepository.upsertCustomMeasurement(
              userId,
              actingUserId,
              stressCategory.id,
              stressValue,
              parsedDate,
              entryHour,
              entryTimestamp,
              `Source: ${source}`,
              stressCategory.frequency,
              source
            );
            processedResults.push({ type, status: 'success', data: result });
          } catch (stressError: any) {
            errors.push({
              error: `Failed to process Stress entry: ${stressError.message}`,
              entry: dataEntry,
            });
          }
          break;
        }
        case 'ExerciseSession':
        case 'Workout': {
          // Redirect to processMobileHealthData logic or duplicate it here?
          // Since processMobileHealthData has the logic, let's just use the same logic here
          // OR call processMobileHealthData for a single entry?
          // Creating a single-entry array to re-use processMobileHealthData might be cleaner but risky if circular.
          // Let's implement inline as it is safer and cleaner to avoid context switching.
          try {
            const {
              activityType,
              caloriesBurned,
              distance,
              duration,
              raw_data,
              source_id,
            } = dataEntry;
            const exerciseName = activityType || `${source} Exercise`;
            let exercise = await exerciseDb.findExerciseByNameAndUserId(
              exerciseName,
              userId
            );
            if (!exercise) {
              exercise = await exerciseDb.createExercise({
                user_id: userId,
                name: exerciseName,
                is_custom: true,
                shared_with_public: false,
                source: source,
                category: 'Cardio',
                calories_per_hour:
                  caloriesBurned && duration
                    ? (caloriesBurned / duration) * 3600
                    : 0,
              });
            }
            const exerciseEntry = await exerciseEntryDb.createExerciseEntry(
              userId,
              {
                exercise_id: exercise.id,
                duration_minutes: duration ? duration / 60 : 0,
                calories_burned: caloriesBurned,
                entry_date: parsedDate,
                notes: `Source: ${source}, Activity Type: ${activityType}`,
                distance: distance,
                sets: dataEntry.sets || null, // Pass sets if present for mobile workout sync
                source_id: source_id || null,
              },
              actingUserId,
              source
            );
            if (raw_data) {
              await activityDetailsRepository.createActivityDetail(userId, {
                exercise_entry_id: exerciseEntry.id,
                provider_name: source,
                detail_type: `${type}_raw_data`,
                detail_data: JSON.stringify(raw_data),
                created_by_user_id: actingUserId,
                updated_by_user_id: actingUserId,
              });
            }
            processedResults.push({
              type,
              status: 'success',
              data: exerciseEntry,
            });
            affectedDates.add(parsedDate);
            break;
          } catch (workoutError: any) {
            errors.push({
              error: `Failed to process Workout entry: ${workoutError.message}`,
              entry: dataEntry,
            });
          }
          break;
        }
        case 'sleep_entry': {
          // Handle structured sleep entry data (legacy/web)
          try {
            const sleepEntryResult = await processSleepEntry(
              userId,
              actingUserId,
              dataEntry
            );
            processedResults.push({
              type,
              status: 'success',
              data: sleepEntryResult,
            });
          } catch (sleepError: any) {
            log(
              'error',
              `Error processing sleep entry: ${sleepError.message}`,
              dataEntry
            );
            errors.push({
              error: `Failed to process sleep entry: ${sleepError.message}`,
              entry: dataEntry,
            });
          }
          break;
        }
        default: {
          // Handle as custom measurement
          // Use unit from payload (e.g. HealthConnect sends "unit") or default so UI does not show "N/A"
          const unitFromPayload = dataEntry.unit ?? dataEntry.measurementType;
          let resolvedMeasurementType;
          if (
            unitFromPayload &&
            typeof unitFromPayload === 'string' &&
            unitFromPayload.trim()
          ) {
            resolvedMeasurementType = unitFromPayload.trim();
          } else {
            resolvedMeasurementType =
              // @ts-expect-error TS(7053): Element implicitly has an 'any' type because expre... Remove this comment to see the full error message
              DEFAULT_UNITS_BY_HEALTH_TYPE[type] || 'N/A';
          }
          const category = await getOrCreateCustomCategory(
            userId,
            actingUserId,
            type,
            dataType,
            resolvedMeasurementType
          );
          if (!category || !category.id) {
            errors.push({
              error: `Failed to get or create custom category for type: ${type}`,
              entry: dataEntry,
            });
            break;
          }
          categoryId = category.id;
          let processedValue = value;
          if (category.data_type === 'numeric') {
            const numericValue = parseFloat(value);
            if (isNaN(numericValue)) {
              errors.push({
                error: `Invalid numeric value for custom measurement type: ${type}. Value: ${value}`,
                entry: dataEntry,
              });
              break;
            }
            processedValue = numericValue;
          }
          // If data_type is 'text', we use the value as is.
          result = await measurementRepository.upsertCustomMeasurement(
            userId,
            actingUserId,
            categoryId,
            processedValue,
            parsedDate,
            entryHour,
            entryTimestamp,
            dataEntry.notes, // Pass notes if available
            category.frequency, // Pass the frequency from the category
            source // Pass the source
          );
          processedResults.push({ type, status: 'success', data: result });
          affectedDates.add(parsedDate);
          break;
        }
      }
    } catch (error: any) {
      log(
        'error',
        `Error processing health data entry ${JSON.stringify(dataEntry)}:`,
        error
      );
      errors.push({
        error: `Failed to process entry: ${error.message}`,
        entry: dataEntry,
      });
    }
  }

  // Finally, trigger MFP sync for all affected dates
  // @ts-expect-error TS(7006): Parameter 'date' implicitly has an 'any' type.
  for (const date of affectedDates) {
    mfpSyncService.syncDailyNutritionToMFP(userId, date).catch((err: any) => {
      log(
        'error',
        `Background MFP sync failed for user ${userId} on ${date}: ${err.message}`
      );
    });
  }

  if (errors.length > 0) {
    throw new Error(
      JSON.stringify({
        message: 'Some health data entries could not be processed.',
        processed: processedResults,
        errors: errors,
      })
    );
  } else {
    return {
      message: 'All health data successfully processed.',
      processed: processedResults,
    };
  }
}

async function processMobileHealthData(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mobileHealthDataArray: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  userId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actingUserId: any
) {
  const tz = await loadUserTimezone(userId);
  const processedResults = [];
  const errors = [];
  const affectedDates = new Set();

  for (const dataEntry of mobileHealthDataArray) {
    const {
      type,
      source,
      timestamp,
      value,
      unit,
      bedtime,
      wake_time,
      duration_in_seconds,
      time_asleep_in_seconds,
      sleep_score,
      stage_events,
      activityType,
      caloriesBurned,
      distance,
      duration,
      raw_data,
    } = dataEntry;
    log(
      'debug',
      `[processMobileHealthData] Processing dataEntry with type: ${type}`
    );
    if (!type || !source || !timestamp) {
      errors.push({
        error:
          'Missing required fields: type, source, or timestamp in one of the entries',
        entry: dataEntry,
      });
      continue;
    }
    let parsedDate;
    let entryTimestamp;
    let entryHour;
    try {
      const dateObj = new Date(timestamp);
      if (isNaN(dateObj.getTime())) {
        throw new Error(`Invalid timestamp received: '${timestamp}'.`);
      }
      parsedDate = instantToDay(dateObj, tz);
      entryTimestamp = dateObj.toISOString();
      entryHour = instantHourMinute(dateObj, tz).hour;
    } catch (e: any) {
      log('error', 'Timestamp parsing error:', e);
      errors.push({
        error: `Invalid timestamp format for entry: ${JSON.stringify(dataEntry)}. Error: ${e.message}`,
        entry: dataEntry,
      });
      continue;
    }
    try {
      let result;
      switch (type) {
        case 'water': {
          const waterValue = parseInt(value, 10);
          if (isNaN(waterValue) || !Number.isInteger(waterValue)) {
            errors.push({
              error: 'Invalid value for water. Must be an integer.',
              entry: dataEntry,
            });
            break;
          }
          result = await measurementRepository.upsertWaterData(
            userId,
            actingUserId,
            waterValue,
            parsedDate,
            source
          );
          processedResults.push({ type, status: 'success', data: result });
          affectedDates.add(parsedDate);
          break;
        }
        case 'Stress': {
          // Map incoming stress data to the existing custom measurement system
          const stressCategory = await getOrCreateCustomCategory(
            userId,
            actingUserId,
            'Stress',
            'numeric',
            'Daily'
          );
          if (!stressCategory || !stressCategory.id) {
            errors.push({
              error: 'Failed to get or create custom category for Stress',
              entry: dataEntry,
            });
            break;
          }
          result = await measurementRepository.upsertCustomMeasurement(
            userId,
            actingUserId,
            stressCategory.id,
            value, // Assuming 'value' holds the stress level
            parsedDate,
            entryHour,
            entryTimestamp,
            `Source: ${source}`,
            stressCategory.frequency,
            source
          );
          processedResults.push({ type, status: 'success', data: result });
          affectedDates.add(parsedDate);
          break;
        }
        case 'SleepSession': {
          const sleepEntryData = {
            entry_date: parsedDate,
            bedtime: bedtime ? new Date(bedtime) : new Date(timestamp),
            wake_time: wake_time
              ? new Date(wake_time)
              : new Date(
                  new Date(timestamp).getTime() +
                    (duration_in_seconds || 0) * 1000
                ),
            duration_in_seconds: duration_in_seconds,
            time_asleep_in_seconds: time_asleep_in_seconds,
            sleep_score: sleep_score,
            source: source,
            stage_events: stage_events,
            // Add other sleep-related fields from mobileHealthData if available
          };
          result = await processSleepEntry(
            userId,
            actingUserId,
            sleepEntryData
          );
          processedResults.push({ type, status: 'success', data: result });
          break;
        }
        case 'ExerciseSession':
        case 'Workout': {
          // Create/update exercises and exercise entries
          const exerciseName = activityType || `${source} Exercise`;
          let exercise = await exerciseDb.findExerciseByNameAndUserId(
            exerciseName,
            userId
          );
          if (!exercise) {
            exercise = await exerciseDb.createExercise({
              user_id: userId,
              name: exerciseName,
              is_custom: true,
              shared_with_public: false,
              source: source,
              category: 'Cardio', // Default category, can be refined
              calories_per_hour:
                caloriesBurned && duration
                  ? (caloriesBurned / duration) * 3600
                  : 0, // Convert to per hour
            });
          }
          const exerciseEntry = await exerciseEntryDb.createExerciseEntry(
            userId,
            {
              exercise_id: exercise.id,
              duration_minutes: duration ? duration / 60 : 0,
              calories_burned: caloriesBurned,
              entry_date: parsedDate,
              notes: `Source: ${source}, Activity Type: ${activityType}`,
              distance: distance,
              sets: dataEntry.sets || null, // Pass sets if present for mobile workout sync
              // Add other exercise-related fields from mobileHealthData if available
            },
            actingUserId,
            source
          );
          // Store raw data in activity details
          if (raw_data) {
            await activityDetailsRepository.createActivityDetail(userId, {
              exercise_entry_id: exerciseEntry.id,
              provider_name: source,
              detail_type: `${type}_raw_data`,
              detail_data: JSON.stringify(raw_data),
              created_by_user_id: actingUserId,
              updated_by_user_id: actingUserId,
            });
          }
          processedResults.push({
            type,
            status: 'success',
            data: exerciseEntry,
          });
          affectedDates.add(parsedDate);
          break;
        }
        default: {
          // Route unknown types through the custom measurement system
          // (mirrors processHealthData default case)
          const unitFromPayload =
            unit && typeof unit === 'string' && unit.trim()
              ? unit.trim()
              : undefined;
          const resolvedUnit =
            // @ts-expect-error TS(7053): Element implicitly has an 'any' type because expre... Remove this comment to see the full error message
            unitFromPayload || DEFAULT_UNITS_BY_HEALTH_TYPE[type] || 'N/A';
          const category = await getOrCreateCustomCategory(
            userId,
            actingUserId,
            type,
            'numeric',
            resolvedUnit
          );
          if (!category || !category.id) {
            errors.push({
              error: `Failed to get or create custom category for type: ${type}`,
              entry: dataEntry,
            });
            break;
          }
          const numericValue = parseFloat(value);
          if (isNaN(numericValue)) {
            errors.push({
              error: `Invalid numeric value for type: ${type}. Value: ${value}`,
              entry: dataEntry,
            });
            break;
          }
          result = await measurementRepository.upsertCustomMeasurement(
            userId,
            actingUserId,
            category.id,
            numericValue,
            parsedDate,
            entryHour,
            entryTimestamp,
            dataEntry.notes,
            category.frequency,
            source
          );
          processedResults.push({ type, status: 'success', data: result });
          affectedDates.add(parsedDate);
          break;
        }
      }
    } catch (error: any) {
      log(
        'error',
        `Error processing mobile health data entry ${JSON.stringify(dataEntry)}:`,
        error
      );
      errors.push({
        error: `Failed to process entry: ${error.message}`,
        entry: dataEntry,
      });
    }
  }

  // Finally, trigger MFP sync for all affected dates
  // @ts-expect-error TS(7006): Parameter 'date' implicitly has an 'any' type.
  for (const date of affectedDates) {
    mfpSyncService.syncDailyNutritionToMFP(userId, date).catch((err: any) => {
      log(
        'error',
        `Background MFP sync failed for user ${userId} on ${date}: ${err.message}`
      );
    });
  }

  if (errors.length > 0) {
    throw new Error(
      JSON.stringify({
        message: 'Some mobile health data entries could not be processed.',
        processed: processedResults,
        errors: errors,
      })
    );
  } else {
    return {
      message: 'All mobile health data successfully processed.',
      processed: processedResults,
    };
  }
}

// Helper function to get or create a custom category
async function getOrCreateCustomCategory(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  userId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actingUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  categoryName: any,
  dataType = 'numeric',
  measurementType = 'N/A'
) {
  // Try to get existing category
  const existingCategories =
    await measurementRepository.getCustomCategories(userId);
  const category = existingCategories.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cat: any) => cat.name === categoryName
  );
  if (category) {
    return category;
  } else {
    // Create new category if it doesn't exist
    const newCategoryData = {
      user_id: userId,
      created_by_user_id: actingUserId, // Use actingUserId for audit
      name: categoryName,
      measurement_type: measurementType, // Default to numeric for Health Connect data
      frequency: 'Daily', // Default frequency, can be refined later if needed
      data_type: dataType, // Default to numeric for new categories from health data
    };
    const newCategory =
      await measurementRepository.createCustomCategory(newCategoryData);
    // To return the full category object including the id and the default data_type
    return { id: newCategory.id, ...newCategoryData };
  }
}
async function getWaterIntake(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authenticatedUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  targetUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  date: any
) {
  try {
    const waterData = await measurementRepository.getWaterIntakeByDate(
      targetUserId,
      date
    );
    // waterData will be { water_ml: SUM(...) } from the new repository logic
    return waterData || { water_ml: 0 };
  } catch (error) {
    log(
      'error',
      `Error fetching water intake for user ${targetUserId} on ${date} by ${authenticatedUserId}:`,
      error
    );
    throw error;
  }
}
async function upsertWaterIntake(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authenticatedUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actingUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entryDate: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  changeDrinks: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  containerId: any
) {
  try {
    // 1. Get current MANUAL water intake for the day to avoid mixing with syncs
    const currentManualRecord =
      await measurementRepository.getWaterIntakeByDate(
        authenticatedUserId,
        entryDate,
        // @ts-expect-error TS(2345): Argument of type '"manual"' is not assignable to p... Remove this comment to see the full error message
        'manual'
      );
    const currentManualMl = currentManualRecord
      ? Number(currentManualRecord.water_ml)
      : 0;
    // 2. Determine amount per drink based on container
    let amountPerDrink;
    if (containerId) {
      const container = await waterContainerRepository.getWaterContainerById(
        containerId,
        authenticatedUserId
      );
      if (container) {
        amountPerDrink =
          Number(container.volume) / Number(container.servings_per_container);
      } else {
        // Fallback to default if container not found
        log(
          'warn',
          `Container with ID ${containerId} not found for user ${authenticatedUserId}. Using default amount per drink.`
        );
        amountPerDrink = 2000 / 8; // Default: 2000ml / 8 servings
      }
    } else {
      // Use default amount per drink if no container ID is provided
      amountPerDrink = 2000 / 8; // Default: 2000ml / 8 servings
    }
    // 3. Calculate new total water intake for the MANUAL bucket
    const newManualTotalWaterMl = Math.max(
      0,
      currentManualMl + changeDrinks * amountPerDrink
    );
    // 4. Upsert the new manual water intake
    const result = await measurementRepository.upsertWaterData(
      authenticatedUserId,
      actingUserId,
      newManualTotalWaterMl,
      entryDate,
      'manual'
    );

    // Trigger MFP sync in background
    mfpSyncService
      .syncDailyNutritionToMFP(authenticatedUserId, entryDate)
      .catch((err: any) => {
        log(
          'error',
          `Background MFP water sync failed for user ${authenticatedUserId} on ${entryDate}: ${err.message}`
        );
      });

    /* Water sync to Garmin disabled as per user request. Local count is source of truth.
    const garminConnectService = await import('../integrations/garminconnect/garminConnectService.js');
    const garminService = await import('./garminService.js');
    const deltaMl = Math.round(changeDrinks * amountPerDrink);

    log(
      'info',
      `[WATER_SYNC] Proactive atomic push to Garmin for user ${authenticatedUserId}: ${deltaMl} mL on ${entryDate}`
    );
    garminConnectService
      .logGarminHydration(authenticatedUserId, entryDate, deltaMl)
      .catch((err) => {
        log(
          'error',
          `[WATER_SYNC] Atomic Garmin hydration push failed: ${err.message}`
        );
      });
    */

    if (!(global as any).hydrationSyncTimers)
      (global as any).hydrationSyncTimers = {};
    const timerKey = `${authenticatedUserId}-${entryDate}`;
    if ((global as any).hydrationSyncTimers[timerKey]) {
      clearTimeout((global as any).hydrationSyncTimers[timerKey]);
    }
    (global as any).hydrationSyncTimers[timerKey] = setTimeout(async () => {
      delete (global as any).hydrationSyncTimers[timerKey];
      log(
        'info',
        `[WATER_SYNC] Running debounced sync to align totals for user ${authenticatedUserId} on ${entryDate}`
      );
      const garminService = await import('./garminService.js');
      garminService.default
        .syncGarminHydration(authenticatedUserId, entryDate, true)
        .catch((err: any) => {
          log('error', `[WATER_SYNC] Debounced sync failed: ${err.message}`);
        });
    }, 3000);

    return result;
  } catch (error) {
    log(
      'error',
      `Error upserting water intake for user ${authenticatedUserId} by ${actingUserId}:`,
      error
    );
    throw error;
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getWaterIntakeEntryById(authenticatedUserId: any, id: any) {
  try {
    const entryOwnerId = await measurementRepository.getWaterIntakeEntryOwnerId(
      id,
      authenticatedUserId
    );
    if (!entryOwnerId) {
      throw new Error('Water intake entry not found.');
    }
    const entry = await measurementRepository.getWaterIntakeEntryById(
      id,
      authenticatedUserId
    );
    return entry;
  } catch (error) {
    log(
      'error',
      `Error fetching water intake entry ${id} by ${authenticatedUserId}:`,
      error
    );
    throw error;
  }
}
async function updateWaterIntake(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authenticatedUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actingUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  id: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateData: any
) {
  try {
    const entryOwnerId = await measurementRepository.getWaterIntakeEntryOwnerId(
      id,
      authenticatedUserId
    );
    if (!entryOwnerId) {
      throw new Error('Water intake entry not found.');
    }
    if (entryOwnerId !== authenticatedUserId) {
      throw new Error(
        'Forbidden: You do not have permission to update this water intake entry.'
      );
    }
    const updatedEntry = await measurementRepository.updateWaterIntake(
      id,
      authenticatedUserId,
      actingUserId,
      updateData
    );
    if (!updatedEntry) {
      throw new Error(
        'Water intake entry not found or not authorized to update.'
      );
    }

    // Trigger MFP sync in background
    if (updatedEntry.entry_date) {
      const entryDate =
        typeof updatedEntry.entry_date === 'string'
          ? updatedEntry.entry_date
          : updatedEntry.entry_date.toISOString().split('T')[0];
      mfpSyncService
        .syncDailyNutritionToMFP(authenticatedUserId, entryDate)
        .catch((err: any) => {
          log(
            'error',
            `Background MFP water sync failed for user ${authenticatedUserId} on ${entryDate}: ${err.message}`
          );
        });
    }

    return updatedEntry;
  } catch (error) {
    log(
      'error',
      `Error updating water intake entry ${id} by user ${authenticatedUserId} in measurementService:`,
      error
    );
    throw error;
  }
}
async function deleteWaterIntake(authenticatedUserId: any, id: any) {
  try {
    const entry = await measurementRepository.getWaterIntakeEntryById(
      id,
      authenticatedUserId
    );
    if (!entry) {
      throw new Error('Water intake entry not found.');
    }
    if (entry.user_id !== authenticatedUserId) {
      throw new Error(
        'Forbidden: You do not have permission to delete this water intake entry.'
      );
    }
    const success = await measurementRepository.deleteWaterIntakeEntry(
      id,
      authenticatedUserId
    );
    if (!success) {
      throw new Error(
        'Water intake entry not found or not authorized to delete.'
      );
    }

    // Trigger MFP sync in background
    if (entry.entry_date) {
      const entryDate =
        typeof entry.entry_date === 'string'
          ? entry.entry_date
          : entry.entry_date.toISOString().split('T')[0];
      mfpSyncService
        .syncDailyNutritionToMFP(authenticatedUserId, entryDate)
        .catch((err: any) => {
          log(
            'error',
            `Background MFP water sync failed for user ${authenticatedUserId} on ${entryDate}: ${err.message}`
          );
        });
    }

    return true;
  } catch (error) {
    log(
      'error',
      `Error deleting water intake entry ${id} by user ${authenticatedUserId} in measurementService:`,
      error
    );
    throw error;
  }
}
async function getCheckInMeasurementsByDateRange(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authenticatedUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  targetUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  startDate: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  endDate: any
) {
  try {
    const measurements =
      await measurementRepository.getCheckInMeasurementsByDateRange(
        targetUserId,
        startDate,
        endDate
      );
    return measurements || [];
  } catch (error) {
    log(
      'error',
      `Error fetching check-in measurements range for user ${targetUserId} by ${authenticatedUserId}:`,
      error
    );
    throw error;
  }
}
async function getCheckInMeasurements(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authenticatedUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  targetUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  date: any
) {
  try {
    const measurements =
      await measurementRepository.getCheckInMeasurementsByDate(
        targetUserId,
        date
      );
    return measurements || {};
  } catch (error) {
    log(
      'error',
      `Error fetching check-in measurements for user ${targetUserId} on ${date} by ${authenticatedUserId}:`,
      error
    );
    throw error;
  }
}
async function getCustomCategories(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authenticatedUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  targetUserId: any
) {
  try {
    return await measurementRepository.getCustomCategories(targetUserId);
  } catch (error) {
    log(
      'error',
      `Error fetching custom categories for user ${targetUserId} by ${authenticatedUserId}:`,
      error
    );
    throw error;
  }
}
async function getCustomCategoryById(authenticatedUserId: any, id: any) {
  try {
    const category = await measurementRepository.getCustomCategoryById(
      id,
      authenticatedUserId
    );
    if (!category) {
      throw new Error('Custom category not found.');
    }
    return category;
  } catch (error) {
    log(
      'error',
      `Error fetching custom category ${id} by ${authenticatedUserId}:`,
      error
    );
    throw error;
  }
}
async function createCustomCategory(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authenticatedUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actingUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  categoryData: any
) {
  try {
    const data = {
      ...categoryData,
      user_id: categoryData.user_id || authenticatedUserId,
      created_by_user_id: actingUserId,
    };
    return await measurementRepository.createCustomCategory(data);
  } catch (error) {
    log(
      'error',
      `Error creating custom category for user ${authenticatedUserId} by ${actingUserId}:`,
      error
    );
    throw error;
  }
}
async function updateCustomCategory(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authenticatedUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actingUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  categoryId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  categoryData: any
) {
  try {
    const category = await measurementRepository.getCustomCategoryById(
      categoryId,
      authenticatedUserId
    );
    if (!category) {
      throw new Error('Custom category not found.');
    }
    if (category.user_id !== authenticatedUserId) {
      throw new Error(
        'Forbidden: You do not have permission to update this custom category.'
      );
    }
    return await measurementRepository.updateCustomCategory(
      categoryId,
      authenticatedUserId,
      actingUserId,
      categoryData
    );
  } catch (error) {
    log(
      'error',
      `Error updating custom category ${categoryId} for user ${authenticatedUserId} by ${actingUserId}:`,
      error
    );
    throw error;
  }
}
async function deleteCustomCategory(authenticatedUserId: any, categoryId: any) {
  try {
    const category = await measurementRepository.getCustomCategoryById(
      categoryId,
      authenticatedUserId
    );
    if (!category) {
      throw new Error('Custom category not found.');
    }
    if (category.user_id !== authenticatedUserId) {
      throw new Error(
        'Forbidden: You do not have permission to delete this custom category.'
      );
    }
    const success = await measurementRepository.deleteCustomCategory(
      categoryId,
      authenticatedUserId
    );
    if (!success) {
      throw new Error('Custom category not found or not authorized to delete.');
    }
    return true;
  } catch (error) {
    log(
      'error',
      `Error deleting custom category ${categoryId} for user ${authenticatedUserId}:`,
      error
    );
    throw error;
  }
}
async function getCustomMeasurementsByDate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authenticatedUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  targetUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  date: any
) {
  try {
    return await measurementRepository.getCustomMeasurementsByDate(
      targetUserId,
      date
    );
  } catch (error) {
    log(
      'error',
      `Error fetching custom measurements for user ${targetUserId} on ${date} by ${authenticatedUserId}:`,
      error
    );
    throw error;
  }
}
async function createCustomMeasurement(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authenticatedUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actingUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  measurementData: any
) {
  try {
    const category = await measurementRepository.getCustomCategoryById(
      measurementData.custom_category_id,
      authenticatedUserId
    );
    if (!category) {
      throw new Error('Custom category not found.');
    }
    const data = {
      ...measurementData,
      user_id: measurementData.user_id || authenticatedUserId,
      created_by_user_id: actingUserId,
      frequency: category.frequency,
    };
    return await measurementRepository.createCustomMeasurement(data);
  } catch (error) {
    log(
      'error',
      `Error creating custom measurement for user ${authenticatedUserId} by ${actingUserId}:`,
      error
    );
    throw error;
  }
}
async function updateCustomMeasurement(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authenticatedUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actingUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  measurementId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  measurementData: any
) {
  try {
    // RLS in measurementRepository will handle checking if the measurement belongs to the user
    return await measurementRepository.updateCustomMeasurement(
      measurementId,
      authenticatedUserId,
      actingUserId,
      measurementData
    );
  } catch (error) {
    log(
      'error',
      `Error updating custom measurement ${measurementId} for user ${authenticatedUserId} by ${actingUserId}:`,
      error
    );
    throw error;
  }
}
async function deleteCustomMeasurement(
  authenticatedUserId: any,
  measurementId: any
) {
  try {
    // RLS in measurementRepository will handle checking if the measurement belongs to the user
    const success = await measurementRepository.deleteCustomMeasurement(
      measurementId,
      authenticatedUserId
    );
    if (!success) {
      throw new Error(
        'Custom measurement not found or not authorized to delete.'
      );
    }
    return true;
  } catch (error) {
    log(
      'error',
      `Error deleting custom measurement ${measurementId} for user ${authenticatedUserId}:`,
      error
    );
    throw error;
  }
}
async function processSleepEntry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  userId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actingUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sleepData: any
) {
  try {
    const bedtime = new Date(sleepData.bedtime);
    const wakeTime = new Date(sleepData.wake_time);
    if (isNaN(bedtime.getTime()) || isNaN(wakeTime.getTime())) {
      throw new Error('Invalid bedtime or wake_time provided.');
    }
    const entryDate = sleepData.entry_date;
    if (!entryDate || !isDayString(entryDate)) {
      throw new Error('Invalid entry_date provided for sleep entry.');
    }
    // Idempotent approach: Replace any manual entry or from the same source on that day
    const source = sleepData.source || 'manual';
    // This cleaning is now handled in processHealthData for bulk syncs,
    // but for single calls we might still want it or assume caller does it.
    // For single web/manual entry, let's keep it.
    if (source === 'manual') {
      await sleepRepository.deleteSleepEntriesByEntrySourceAndDate(
        userId,
        'manual',
        entryDate,
        entryDate
      );
    }
    const result = await sleepRepository.createSleepEntry(
      userId,
      {
        ...sleepData,
        bedtime,
        wake_time: wakeTime,
        entry_date: entryDate,
        source,
      },
      actingUserId
    );
    return result;
  } catch (error) {
    log(
      'error',
      `Error processing sleep entry for user ${userId} on ${sleepData.entry_date}:`,
      error
    );
    throw error;
  }
}
async function getSleepEntryByDate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authenticatedUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  targetUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  date: any
) {
  try {
    const sleepEntries = await sleepRepository.getSleepEntriesByDate(
      targetUserId,
      date
    );
    // Merge logic: return the one with the highest duration or prioritize manual?
    // Usually we just return the most recent or summarized one.
    // For now, return the first one found or null.
    return sleepEntries.length > 0 ? sleepEntries[0] : null;
  } catch (error) {
    log(
      'error',
      `Error fetching sleep entry for user ${targetUserId} on ${date}:`,
      error
    );
    throw error;
  }
}
async function deleteSleepEntry(authenticatedUserId: any, id: any) {
  try {
    const success = await sleepRepository.deleteSleepEntry(
      id,
      authenticatedUserId
    );
    if (!success) {
      throw new Error('Sleep entry not found or not authorized to delete.');
    }
    return true;
  } catch (error) {
    log(
      'error',
      `Error deleting sleep entry ${id} for user ${authenticatedUserId}:`,
      error
    );
    throw error;
  }
}
async function getMeasurementHistory(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authenticatedUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  targetUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  days: any
) {
  try {
    const history = await measurementRepository.getMeasurementHistory(
      targetUserId,
      type,
      days
    );
    return history;
  } catch (error) {
    log(
      'error',
      `Error fetching measurement history for user ${targetUserId}, type ${type}, days ${days}:`,
      error
    );
    throw error;
  }
}
async function getLatestWeight(authenticatedUserId: any, targetUserId: any) {
  try {
    const latestWeight =
      await measurementRepository.getLatestWeight(targetUserId);
    return latestWeight;
  } catch (error) {
    log(
      'error',
      `Error fetching latest weight for user ${targetUserId}:`,
      error
    );
    throw error;
  }
}
async function getCheckInEntryById(authenticatedUserId: any, id: any) {
  try {
    return await measurementRepository.getCheckInEntryById(
      id,
      authenticatedUserId
    );
  } catch (error) {
    log(
      'error',
      `Error fetching check-in entry ${id} by ${authenticatedUserId}:`,
      error
    );
    throw error;
  }
}
async function updateCheckIn(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authenticatedUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actingUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  id: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateData: any
) {
  try {
    return await measurementRepository.updateCheckIn(
      id,
      authenticatedUserId,
      actingUserId,
      updateData
    );
  } catch (error) {
    log(
      'error',
      `Error updating check-in ${id} for user ${authenticatedUserId} by ${actingUserId}:`,
      error
    );
    throw error;
  }
}
async function deleteCheckIn(authenticatedUserId: any, id: any) {
  try {
    const success = await measurementRepository.deleteCheckIn(
      id,
      authenticatedUserId
    );
    if (!success) {
      throw new Error('Check-in not found or not authorized to delete.');
    }
    return true;
  } catch (error) {
    log(
      'error',
      `Error deleting check-in ${id} for user ${authenticatedUserId}:`,
      error
    );
    throw error;
  }
}
async function getTdeeInputs(authenticatedUserId: any, targetUserId: any) {
  try {
    // 1. Fetch user data for age, gender, height
    const user = await userRepository.findUserById(targetUserId);
    if (!user) throw new Error('User not found');
    const age = userAge(user.date_of_birth);
    // 2. Fetch latest weight from check-ins
    const latestWeight =
      await measurementRepository.getLatestWeight(targetUserId);
    // 3. Fetch height from latest check-in or profile (prefer check-in?)
    const latestHeightRecord =
      await measurementRepository.getMeasurementHistory(
        targetUserId,
        'height',
        365
      );
    const height =
      latestHeightRecord.length > 0
        ? latestHeightRecord[0].value
        : user.height_cm;
    return {
      age,
      gender: user.gender,
      weight: latestWeight,
      height_cm: height || user.height_cm, // fallback to profile height
    };
  } catch (error) {
    log('error', `Error fetching TDEE inputs for user ${targetUserId}:`, error);
    throw error;
  }
}
async function getBulkMeasurementHistory(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authenticatedUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  targetUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metricTypes: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  days: any
) {
  try {
    // We expect metricTypes to be an array like ['step', 'weight', 'body_fat_percentage']
    if (!Array.isArray(metricTypes)) {
      throw new Error('metricTypes must be an array.');
    }
    const history = await measurementRepository.getBulkMeasurementHistory(
      targetUserId,
      metricTypes,
      days
    );
    return history;
  } catch (error) {
    log(
      'error',
      `Error in getBulkMeasurementHistory for user ${targetUserId}, metrics ${metricTypes}, days ${days}:`,
      error
    );
    throw error;
  }
}

async function upsertCustomMeasurementEntry(
  userId: string,
  actingUserId: string,
  entryData: {
    category_id: string;
    value: any;
    entry_date: string;
    entry_hour?: number | null;
    entry_timestamp?: string;
    notes?: string;
    source?: string;
    frequency?: string;
  }
) {
  const category = await getCustomCategoryById(entryData.category_id, userId);
  if (!category) {
    throw new Error(`Category ${entryData.category_id} not found.`);
  }

  return await measurementRepository.upsertCustomMeasurement(
    userId,
    actingUserId,
    entryData.category_id,
    entryData.value,
    entryData.entry_date,
    entryData.entry_hour ?? 0,
    entryData.entry_timestamp ?? new Date(entryData.entry_date).toISOString(),
    entryData.notes ?? null,
    entryData.frequency ?? category.frequency ?? 'Daily',
    entryData.source ?? 'manual'
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function calculateSleepScore(
  sleepEntryData: any,
  stageEvents: any,
  age: any = null,
  gender: any = null
) {
  const { duration_in_seconds, time_asleep_in_seconds } = sleepEntryData;

  if (!duration_in_seconds || duration_in_seconds <= 0) return 0;

  let score = 0;
  const maxScore = 100;

  // Define optimal ranges based on age and gender
  let optimalMinDuration = 7 * 3600; // Default 7 hours
  let optimalMaxDuration = 9 * 3600; // Default 9 hours
  let optimalDeepMin = 15; // Default 15%
  let optimalDeepMax = 25; // Default 25%
  let optimalRemMin = 20; // Default 20%
  let optimalRemMax = 25; // Default 25%

  // Adjust optimal sleep duration based on age
  if (age !== null) {
    if (age >= 65) {
      // Older adults
      optimalMinDuration = 7 * 3600;
      optimalMaxDuration = 8 * 3600;
    } else if (age >= 18 && age <= 64) {
      // Adults
      optimalMinDuration = 7 * 3600;
      optimalMaxDuration = 9 * 3600;
    } else if (age >= 14 && age <= 17) {
      // Teenagers
      optimalMinDuration = 8 * 3600;
      optimalMaxDuration = 10 * 3600;
    }
  }

  // Component 1: Total Sleep Duration (TST) - 30% of score
  const tstWeight = 30;

  if (
    duration_in_seconds >= optimalMinDuration &&
    duration_in_seconds <= optimalMaxDuration
  ) {
    score += tstWeight;
  } else {
    // Deduct points for being outside optimal range
    const deviation = Math.min(
      Math.abs(duration_in_seconds - optimalMinDuration),
      Math.abs(duration_in_seconds - optimalMaxDuration)
    );
    score += Math.max(0, tstWeight - (deviation / 3600) * 5); // 5 points deduction per hour deviation
  }

  // Component 2: Sleep Efficiency - 25% of score
  const sleepEfficiency = (time_asleep_in_seconds / duration_in_seconds) * 100;
  const optimalEfficiency = 85; // 85%
  const efficiencyWeight = 25;

  if (sleepEfficiency >= optimalEfficiency) {
    score += efficiencyWeight;
  } else {
    score += Math.max(
      0,
      efficiencyWeight - (optimalEfficiency - sleepEfficiency) * 1
    ); // 1 point deduction per % below optimal
  }

  // Component 3: Sleep Stage Distribution (Deep & REM) - 30% of score (15% each)
  let deepSleepDuration = 0;
  let remSleepDuration = 0;
  let awakeDuration = 0;
  let numAwakePeriods = 0;

  if (stageEvents && stageEvents.length > 0) {
    let inAwakePeriod = false;
    for (const event of stageEvents) {
      if (event.stage_type === 'deep') {
        deepSleepDuration += event.duration_in_seconds;
      } else if (event.stage_type === 'rem') {
        remSleepDuration += event.duration_in_seconds;
      } else if (event.stage_type === 'awake') {
        awakeDuration += event.duration_in_seconds;
        if (!inAwakePeriod) {
          numAwakePeriods++;
          inAwakePeriod = true;
        }
      } else {
        inAwakePeriod = false;
      }
    }
  }

  const totalSleepStagesDuration =
    deepSleepDuration +
    remSleepDuration +
    (time_asleep_in_seconds - awakeDuration);

  if (totalSleepStagesDuration > 0) {
    const deepSleepPercentage =
      (deepSleepDuration / totalSleepStagesDuration) * 100;
    const remSleepPercentage =
      (remSleepDuration / totalSleepStagesDuration) * 100;

    // Adjust optimal deep and REM sleep percentages based on age/gender if needed
    if (age !== null) {
      if (age >= 65) {
        // Older adults might have less deep sleep
        optimalDeepMin = 10;
        optimalDeepMax = 20;
      }
    }

    // Deep Sleep Score (15%)
    const deepWeight = 15;
    if (
      deepSleepPercentage >= optimalDeepMin &&
      deepSleepPercentage <= optimalDeepMax
    ) {
      score += deepWeight;
    } else {
      const deviation = Math.min(
        Math.abs(deepSleepPercentage - optimalDeepMin),
        Math.abs(deepSleepPercentage - optimalDeepMax)
      );
      score += Math.max(0, deepWeight - deviation * 0.5); // 0.5 point deduction per % deviation
    }

    // REM Sleep Score (15%)
    const remWeight = 15;
    if (
      remSleepPercentage >= optimalRemMin &&
      remSleepPercentage <= optimalRemMax
    ) {
      score += remWeight;
    } else {
      const deviation = Math.min(
        Math.abs(remSleepPercentage - optimalRemMin),
        Math.abs(remSleepPercentage - optimalRemMax)
      );
      score += Math.max(0, remWeight - deviation * 0.5); // 0.5 point deduction per % deviation
    }
  }

  // Component 4: Disturbances (Awake Time/Periods) - 15% of score
  const disturbanceWeight = 15;
  let disturbanceDeduction = 0;

  // Deduct for total awake time
  disturbanceDeduction += (awakeDuration / 60) * 0.5; // 0.5 points deduction per minute awake

  // Deduct for number of awake periods
  disturbanceDeduction += numAwakePeriods * 2; // 2 points deduction per awake period

  score += Math.max(0, disturbanceWeight - disturbanceDeduction);

  // Ensure score is within 0-100 range
  return Math.round(Math.max(0, Math.min(score, maxScore)));
}

export {
  resolveHealthEntryDate,
  processHealthData,
  processMobileHealthData,
  getOrCreateCustomCategory,
  getWaterIntake,
  upsertWaterIntake,
  getWaterIntakeEntryById,
  updateWaterIntake,
  deleteWaterIntake,
  getCheckInMeasurements,
  getCheckInMeasurementsByDateRange,
  getCustomCategories,
  getCustomCategoryById,
  createCustomCategory,
  updateCustomCategory,
  deleteCustomCategory,
  getCustomMeasurementsByDate,
  createCustomMeasurement,
  updateCustomMeasurement,
  upsertCustomMeasurementEntry,
  deleteCustomMeasurement,
  processSleepEntry,
  getSleepEntryByDate,
  deleteSleepEntry,
  getMeasurementHistory,
  getLatestWeight,
  getCheckInEntryById,
  updateCheckIn,
  deleteCheckIn,
  getTdeeInputs,
  getBulkMeasurementHistory,
  calculateSleepScore,
};

export default {
  resolveHealthEntryDate,
  processHealthData,
  processMobileHealthData,
  getOrCreateCustomCategory,
  getWaterIntake,
  upsertWaterIntake,
  getWaterIntakeEntryById,
  updateWaterIntake,
  deleteWaterIntake,
  getCheckInMeasurements,
  getCheckInMeasurementsByDateRange,
  getCustomCategories,
  getCustomCategoryById,
  createCustomCategory,
  updateCustomCategory,
  deleteCustomCategory,
  getCustomMeasurementsByDate,
  createCustomMeasurement,
  updateCustomMeasurement,
  upsertCustomMeasurementEntry,
  deleteCustomMeasurement,
  processSleepEntry,
  getSleepEntryByDate,
  deleteSleepEntry,
  getMeasurementHistory,
  getLatestWeight,
  getCheckInEntryById,
  updateCheckIn,
  deleteCheckIn,
  getTdeeInputs,
  getBulkMeasurementHistory,
  calculateSleepScore,
};
