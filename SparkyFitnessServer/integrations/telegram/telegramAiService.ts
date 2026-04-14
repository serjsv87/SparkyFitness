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
import { TelegramUser } from './telegramTranslations.js';

export class TelegramAiService {
  static buildContextBlock(
    user: TelegramUser,
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

    const sections: string[] = [
      `SYSTEM CONTEXT FOR SPARKY FITNESS AI (TELEGRAM):\n- Current Date: ${today}\n- Current Time: ${timeStr} (${tz}) — ${timeOfDay}\n- Active User: ${user.name} (ID: ${user.id})\n- Preferred Language: ${user.language || 'en'}`,
    ];

    if (nutritionContext && nutritionContext.trim()) {
      sections.push(
        `USER'S PHYSICAL PROFILE & NUTRITION GOALS:\n${nutritionContext.trim()}`
      );
    }

    if (exerciseSummary && exerciseSummary.trim()) {
      sections.push(
        `USER'S RECENT EXERCISE HISTORY (Last 7 Days):\n${exerciseSummary.trim()}`
      );
    }

    if (userPlan && userPlan.trim()) {
      sections.push(`[USER NUTRITION PLAN]\n${userPlan.trim()}`);
    }

    if (extraContext && extraContext.trim()) {
      sections.push(extraContext.trim());
    }

    sections.push(`BEHAVIORAL INSTRUCTIONS:
1. You are Sparky, a professional and motivating fitness coach.
2. You are communicating via Telegram. Keep your responses VERY CONCISE, friendly, and use Markdown (bold, lists).
3. When the user asks about "workouts", "sessions", or "exercises" (e.g., "последние занятия"), refer to the Exercise History provided above.
4. For every message, you MUST identify the intent (log_food, log_exercise, log_measurement, chat, etc.) and return it in the JSON format as defined in your main system prompt.
5. If you are just chatting or answering a question without a specific log intent, use the "chat" or "ask_question" intent and put your response in the "response" field.`);

    return sections.join('\n\n');
  }

  private static formatFoodHistory(
    recentFoods: Record<string, unknown>[],
    tz: string,
    today: string
  ): string {
    if (!recentFoods || recentFoods.length === 0) {
      return '';
    }

    const yesterday = addDays(today, -1);
    const foodsByDate: Record<string, Record<string, unknown>[]> = {};
    recentFoods.forEach((food: Record<string, unknown>) => {
      const date = food.entry_date
        ? instantToDay(food.entry_date as string, tz)
        : 'Unknown';
      if (!foodsByDate[date]) foodsByDate[date] = [];
      foodsByDate[date].push(food);
    });

    const mealLabels: Record<string, string> = {
      breakfast: 'Сніданок',
      lunch: 'Обід',
      dinner: 'Вечеря',
      snacks: 'Перекуси',
    };

    const mealOrder = ['breakfast', 'lunch', 'dinner', 'snacks'];
    const sortedDates = Object.keys(foodsByDate).sort((a, b) =>
      b.localeCompare(a)
    );
    const lines: string[] = [];

    for (const date of sortedDates) {
      const dayFoods = foodsByDate[date];
      const dayTotal = dayFoods.reduce(
        (sum, food) => sum + Number(food.calories || 0),
        0
      );
      const detailed = date === today || date === yesterday;
      const dayLabel =
        date === today
          ? `${date} (today)`
          : date === yesterday
            ? `${date} (yesterday)`
            : date;

      if (!detailed) {
        lines.push(`  📅 ${dayLabel}: ${Math.round(dayTotal)} kcal`);
        continue;
      }

      lines.push(`  📅 ${dayLabel}:`);
      const grouped = new Map<string, Record<string, unknown>[]>();
      for (const food of dayFoods) {
        const mealType = ((food.meal_type as string) || 'snacks').toLowerCase();
        if (!grouped.has(mealType)) grouped.set(mealType, []);
        grouped.get(mealType)!.push(food);
      }

      for (const mealType of mealOrder) {
        const items = grouped.get(mealType);
        if (!items || items.length === 0) continue;
        const mealNames = items
          .map(
            (item) =>
              (item.food_name as string) || (item.name as string) || 'Food'
          )
          .join(', ');
        const mealTotal = items.reduce(
          (sum, item) => sum + Number(item.calories || 0),
          0
        );
        lines.push(
          `    - ${mealLabels[mealType] || mealType}: ${mealNames} (${Math.round(mealTotal)} kcal)`
        );
      }

      lines.push(`    → Day total: ${Math.round(dayTotal)} kcal`);
    }

    return lines.join('\n');
  }

  static async getUserNutritionContext(userId: string): Promise<string> {
    try {
      const tz = await loadUserTimezone(userId);
      const today = todayInZone(tz);
      const startDate = addDays(today, -6);

      const [
        profile,
        prefs,
        goal,
        todayFoods,
        todayExercises,
        recentFoods,
        latestMeasurement,
      ] = await Promise.all([
        userRepository.getUserProfile(userId),
        preferenceRepository.getUserPreferences(userId),
        goalRepository.getMostRecentGoalBeforeDate(userId, today),
        foodEntry.getFoodEntriesByDate(userId, today),
        exerciseEntry.getExerciseEntriesByDate(userId, today),
        foodEntry.getFoodEntriesByDateRange(userId, startDate, today),
        measurementRepository.getLatestCheckInMeasurementsOnOrBeforeDate(
          userId,
          today
        ),
      ]);

      if (!profile && !goal) return '';

      let age = null;
      if (profile?.date_of_birth) {
        const dob = new Date(profile.date_of_birth as string);
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
          (bmrService.ActivityMultiplier as Record<string, number>)[
            activityLevel
          ] || 1.2;
        tdee = bmr * multiplier;
      }

      const caloriesConsumed = todayFoods.reduce(
        (sum: number, f: Record<string, unknown>) =>
          sum + Number(f.calories || 0),
        0
      );
      const proteinConsumed = todayFoods.reduce(
        (sum: number, f: Record<string, unknown>) =>
          sum + Number(f.protein || 0),
        0
      );
      const carbsConsumed = todayFoods.reduce(
        (sum: number, f: Record<string, unknown>) => sum + Number(f.carbs || 0),
        0
      );
      const fatConsumed = todayFoods.reduce(
        (sum: number, f: Record<string, unknown>) => sum + Number(f.fat || 0),
        0
      );
      const caloriesBurnedToday = todayExercises.reduce(
        (sum: number, e: Record<string, unknown>) =>
          sum + Number(e.calories_burned || 0),
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

      if (goal?.protein) {
        context += `- Macronutrient Targets: ${goal.protein}g P, ${goal.carbs}g C, ${goal.fat}g F\n`;
      }

      if (recentFoods.length > 0) {
        const foodHistory = TelegramAiService.formatFoodHistory(
          recentFoods,
          tz,
          today
        );
        if (foodHistory) {
          context += `\nFOOD HISTORY (LAST 7 DAYS, compressed):\n${foodHistory}`;
        }
      }

      return context;
    } catch (error: unknown) {
      log(
        'error',
        '[TELEGRAM BOT] Error building nutrition context:',
        error instanceof Error ? error.message : String(error)
      );
      return '';
    }
  }
}
