import { log } from '../../config/logging.js';
import * as userRepository from '../../models/userRepository.js';
import * as preferenceRepository from '../../models/preferenceRepository.js';
import * as goalRepository from '../../models/goalRepository.js';
import * as foodEntry from '../../models/foodEntry.js';
import * as exerciseEntry from '../../models/exerciseEntry.js';
import * as measurementRepository from '../../models/measurementRepository.js';
import {
  todayInZone,
  addDays,
  instantToDay,
  instantHourMinute,
} from '@workspace/shared';

import * as bmrService from '../../services/bmrService.js';
import { loadUserTimezone } from '../../utils/timezoneLoader.js';

export class TelegramAiService {
  static buildContextBlock(
    user: any,
    exerciseSummary: string,
    nutritionContext: string = '',
    extraContext: string = '',
    userPlan: string = ''
  ): string {
    const tz = user.timezone || 'UTC';
    const today = todayInZone(tz);
    const now = new Date();
    const { hour, minute } = instantHourMinute(now, tz);
    const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    let timeOfDay: string;
    if (hour >= 5 && hour < 12) timeOfDay = 'morning (ранок)';
    else if (hour >= 12 && hour < 17) timeOfDay = 'afternoon (обід/день)';
    else if (hour >= 17 && hour < 22) timeOfDay = 'evening (вечір)';
    else timeOfDay = 'night (ніч)';
    return `
SYSTEM CONTEXT FOR SPARKY FITNESS AI (TELEGRAM):
- Current Date: ${today}
- Current Time: ${timeStr} (${tz}) — ${timeOfDay}
- Active User: ${user.name} (ID: ${user.id})
- Preferred Language: ${user.language || 'en'}

USER'S PHYSICAL PROFILE & NUTRITION GOALS:
${nutritionContext || 'No profile or goal data available.'}

USER'S RECENT EXERCISE HISTORY (Last 7 Days):
${exerciseSummary || 'No recent exercises found.'}

BEHAVIORAL INSTRUCTIONS:
1. You are Sparky, a professional and motivating fitness coach.
2. You are communicating via Telegram. Keep your responses VERY CONCISE, friendly, and use Markdown (bold, lists).
3. When the user asks about "workouts", "sessions", or "exercises" (e.g., "последние занятия"), refer to the Exercise History provided above.
4. For every message, you MUST identify the intent (log_food, log_exercise, log_measurement, chat, etc.) and return it in the JSON format as defined in your main system prompt.
5. If you are just chatting or answering a question without a specific log intent, use the "chat" or "ask_question" intent and put your response in the "response" field.

[USER NUTRITION PLAN]
${userPlan || 'No specific nutrition plan rules provided yet.'}

${extraContext}
`;
  }

  static async getUserNutritionContext(userId: string): Promise<string> {
    try {
      const tz = await loadUserTimezone(userId);
      const today = todayInZone(tz);
      const startDate = addDays(today, -7);

      const [
        profile,
        prefs,
        goal,
        todayFoods,
        todayExercises,
        recentFoods,
        recentExercises,
        latestMeasurement,
      ] = await Promise.all([
        userRepository.getUserProfile(userId),
        preferenceRepository.getUserPreferences(userId),
        goalRepository.getMostRecentGoalBeforeDate(userId, today),
        foodEntry.getFoodEntriesByDate(userId, today),
        exerciseEntry.getExerciseEntriesByDate(userId, today),
        foodEntry.getFoodEntriesByDateRange(userId, startDate, today),
        exerciseEntry.getExerciseEntriesByDateRange(userId, startDate, today),
        measurementRepository.getLatestCheckInMeasurementsOnOrBeforeDate(
          userId,
          today
        ),
      ]);

      if (!profile && !goal) return '';

      let age = null;
      if (profile?.date_of_birth) {
        const dob = new Date(profile.date_of_birth);
        const ageDifMs = Date.now() - dob.getTime();
        const ageDate = new Date(ageDifMs);
        age = Math.abs(ageDate.getUTCFullYear() - 1970);
      }

      const weight = latestMeasurement?.weight || null;
      const height = latestMeasurement?.height || null;
      const gender = profile?.gender || null;

      let bmr = 0;
      let tdee = 0;
      if (weight && height && age && gender && prefs) {
        bmr = bmrService.calculateBmr(
          prefs.bmr_algorithm || bmrService.BmrAlgorithm.MIFFLIN_ST_JEOR,
          weight,
          height,
          age,
          gender,
          null
        );
        const activityLevel = prefs.activity_level || 'sedentary';
        const multiplier =
          (bmrService.ActivityMultiplier as any)[activityLevel] || 1.2;
        tdee = bmr * multiplier;
      }

      const caloriesConsumed = todayFoods.reduce(
        (sum: number, f: any) => sum + Number(f.calories || 0),
        0
      );
      const proteinConsumed = todayFoods.reduce(
        (sum: number, f: any) => sum + Number(f.protein || 0),
        0
      );
      const carbsConsumed = todayFoods.reduce(
        (sum: number, f: any) => sum + Number(f.carbs || 0),
        0
      );
      const fatConsumed = todayFoods.reduce(
        (sum: number, f: any) => sum + Number(f.fat || 0),
        0
      );
      const caloriesBurnedToday = todayExercises.reduce(
        (sum: number, e: any) => sum + Number(e.calories_burned || 0),
        0
      );

      const calGoal = Number(goal?.calories || 2000);
      const remaining = calGoal + caloriesBurnedToday - caloriesConsumed;

      let context = `- Gender: ${gender || 'Unknown'}\n`;
      if (age) context += `- Age: ${age} years\n`;
      if (weight) context += `- Current Weight: ${weight} kg\n`;
      if (height) context += `- Height: ${height} cm\n`;
      if (bmr) context += `- Calculated BMR: ${Math.round(bmr)} kcal\n`;
      if (tdee) context += `- TDEE (Maintenance): ${Math.round(tdee)} kcal\n`;

      context += `\nDAILY GOALS & PROGRESS (${today}):\n`;
      context += `- Daily Base Calorie Goal: ${calGoal} kcal\n`;
      context += `- Active Calories Burned Today: ${Math.round(caloriesBurnedToday)} kcal\n`;
      context += `- Consumed Today: ${Math.round(caloriesConsumed)} kcal (${Math.round(proteinConsumed)}g P, ${Math.round(carbsConsumed)}g C, ${Math.round(fatConsumed)}g F)\n`;
      context += `- REMAINING CALORIES: ${Math.round(remaining)} kcal (Goal + Burned - Consumed)\n`;

      if (goal?.protein)
        context += `- Macronutrient Targets: ${goal.protein}g P, ${goal.carbs}g C, ${goal.fat}g F\n`;

      if (recentFoods.length > 0) {
        context += `\nFOOD HISTORY (LAST 7 DAYS, grouped by date):\n`;
        const foodByDate: Record<string, any[]> = {};
        recentFoods.forEach((f: any) => {
          const date = f.entry_date
            ? instantToDay(f.entry_date, tz)
            : 'Unknown';
          if (!foodByDate[date]) foodByDate[date] = [];
          foodByDate[date].push(f);
        });
        Object.keys(foodByDate)
          .sort()
          .forEach((date) => {
            const dayLabel = date === today ? `${date} (today)` : date;
            context += `\n  📅 ${dayLabel}:\n`;
            let dayTotal = 0;
            foodByDate[date].forEach((f: any) => {
              const kcal = Number(f.calories || 0);
              dayTotal += kcal;
              context += `    - [${f.meal_type || 'snack'}] ${f.food_name || f.name}: ${kcal} kcal\n`;
            });
            context += `    → Day total: ${Math.round(dayTotal)} kcal\n`;
          });
      }

      if (recentExercises.length > 0) {
        context += `\nEXERCISE HISTORY (LAST 7 DAYS, grouped by date):\n`;
        const exByDate: Record<string, any[]> = {};
        recentExercises.forEach((e: any) => {
          const date = e.entry_date
            ? instantToDay(e.entry_date, tz)
            : 'Unknown';
          if (!exByDate[date]) exByDate[date] = [];
          exByDate[date].push(e);
        });
        Object.keys(exByDate)
          .sort()
          .forEach((date) => {
            const dayLabel = date === today ? `${date} (today)` : date;
            context += `\n  📅 ${dayLabel}:\n`;
            exByDate[date].forEach((e: any) => {
              context += `    - ${e.exercise_name || e.name}: ${e.duration_minutes}min, ${e.calories_burned} kcal burned\n`;
            });
          });
      }

      return context;
    } catch (e: any) {
      log(
        'error',
        '[TELEGRAM BOT] Error building nutrition context:',
        e.message
      );
      return '';
    }
  }
}
