import foodRepository from '../models/foodRepository.js';
import foodEntryMealRepository from '../models/foodEntryMealRepository.js';
import mealService from './mealService.js';
import { log } from '../config/logging.js';
import mealTypeRepository from '../models/mealType.js';
import { sanitizeCustomNutrients } from '../utils/foodUtils.js';
import * as mfpSyncService from './mfpSyncService.js';

// Helper functions (already defined)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getGlycemicIndexValue(category: any) {
  switch (category) {
    case 'Very Low':
      return 10;
    case 'Low':
      return 30;
    case 'Medium':
      return 60;
    case 'High':
      return 80;
    case 'Very High':
      return 100;
    default:
      return null;
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getGlycemicIndexCategory(value: any) {
  if (value === null) return 'None';
  if (value <= 20) return 'Very Low';
  if (value <= 50) return 'Low';
  if (value <= 70) return 'Medium';
  if (value <= 90) return 'High';
  return 'Very High';
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveMealTypeId(userId: any, mealTypeName: any) {
  if (!mealTypeName) return null;
  const types = await mealTypeRepository.getAllMealTypes(userId);
  const match = types.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (t: any) => t.name.toLowerCase() === mealTypeName.toLowerCase()
  );
  return match ? match.id : null;
}

async function createFoodEntry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authenticatedUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actingUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entryData: any
) {
  try {
    const entryWithUser = {
      ...entryData,
      user_id: entryData.user_id || authenticatedUserId,
      created_by_user_id: actingUserId,
    };
    if (entryData.custom_nutrients !== undefined) {
      entryWithUser.custom_nutrients = sanitizeCustomNutrients(
        entryData.custom_nutrients
      );
    }
    log(
      'info',
      `createFoodEntry in foodService: authenticatedUserId: ${authenticatedUserId}, actingUserId: ${actingUserId}, entryData: ${JSON.stringify(entryData)}`
    );
    const newEntry = await foodRepository.createFoodEntry(
      entryWithUser,
      actingUserId
    );

    // Sync to MyFitnessPal if active
    mfpSyncService
      .syncDailyNutritionToMFP(authenticatedUserId, entryData.entry_date)
      .catch((err: any) => {
        log(
          'warn',
          `[MFP SYNC] Real-time sync failed after createFoodEntry: ${err.message}`
        );
      });

    return newEntry;
  } catch (error) {
    log(
      'error',
      `Error creating food entry for user ${authenticatedUserId} by ${actingUserId} in foodService:`,
      error
    );
    throw error;
  }
}
async function updateFoodEntry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authenticatedUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actingUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entryId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entryData: any
) {
  try {
    const entryOwnerId = await foodRepository.getFoodEntryOwnerId(
      entryId,
      authenticatedUserId
    );
    if (!entryOwnerId) {
      throw new Error('Food entry not found.');
    }
    if (entryOwnerId !== authenticatedUserId) {
      throw new Error(
        'Forbidden: You do not have permission to update this food entry.'
      );
    }
    // Fetch the existing entry to get food_id and current variant_id if not provided in entryData
    const existingEntry = await foodRepository.getFoodEntryById(
      entryId,
      authenticatedUserId
    );
    if (!existingEntry) {
      throw new Error('Food entry not found.');
    }
    const foodIdToUse = existingEntry.food_id;
    const variantIdToUse = entryData.variant_id || existingEntry.variant_id;
    let newSnapshotData;
    if (foodIdToUse) {
      // Variant changed — rebuild snapshot from the new food/variant
      const food = await foodRepository.getFoodById(
        foodIdToUse,
        authenticatedUserId
      );
      if (!food) {
        throw new Error('Food not found for snapshotting.');
      }
      const variant = await foodRepository.getFoodVariantById(
        variantIdToUse,
        authenticatedUserId
      );
      if (!variant) {
        throw new Error('Food variant not found for snapshotting.');
      }
      newSnapshotData = {
        food_name: food.name,
        brand_name: food.brand,
        serving_size: variant.serving_size,
        serving_unit: variant.serving_unit,
        calories: variant.calories,
        protein: variant.protein,
        carbs: variant.carbs,
        fat: variant.fat,
        saturated_fat: variant.saturated_fat,
        polyunsaturated_fat: variant.polyunsaturated_fat,
        monounsaturated_fat: variant.monounsaturated_fat,
        trans_fat: variant.trans_fat,
        cholesterol: variant.cholesterol,
        sodium: variant.sodium,
        potassium: variant.potassium,
        dietary_fiber: variant.dietary_fiber,
        sugars: variant.sugars,
        vitamin_a: variant.vitamin_a,
        vitamin_c: variant.vitamin_c,
        calcium: variant.calcium,
        iron: variant.iron,
        glycemic_index: variant.glycemic_index,
        custom_nutrients: sanitizeCustomNutrients(variant.custom_nutrients),
      };
    } else {
      // No variant change or no linked food — preserve existing entry's snapshot
      newSnapshotData = {
        food_name: existingEntry.food_name,
        brand_name: existingEntry.brand_name,
        serving_size: existingEntry.serving_size,
        serving_unit: existingEntry.serving_unit,
        calories: existingEntry.calories,
        protein: existingEntry.protein,
        carbs: existingEntry.carbs,
        fat: existingEntry.fat,
        saturated_fat: existingEntry.saturated_fat,
        polyunsaturated_fat: existingEntry.polyunsaturated_fat,
        monounsaturated_fat: existingEntry.monounsaturated_fat,
        trans_fat: existingEntry.trans_fat,
        cholesterol: existingEntry.cholesterol,
        sodium: existingEntry.sodium,
        potassium: existingEntry.potassium,
        dietary_fiber: existingEntry.dietary_fiber,
        sugars: existingEntry.sugars,
        vitamin_a: existingEntry.vitamin_a,
        vitamin_c: existingEntry.vitamin_c,
        calcium: existingEntry.calcium,
        iron: existingEntry.iron,
        glycemic_index: existingEntry.glycemic_index,
        custom_nutrients: sanitizeCustomNutrients(
          existingEntry.custom_nutrients
        ),
      };
    }
    // Apply inline nutrition overrides if provided by the client
    const nutritionOverrideFields = [
      'food_name',
      'brand_name',
      'serving_size',
      'serving_unit',
      'calories',
      'protein',
      'carbs',
      'fat',
      'saturated_fat',
      'polyunsaturated_fat',
      'monounsaturated_fat',
      'trans_fat',
      'cholesterol',
      'sodium',
      'potassium',
      'dietary_fiber',
      'sugars',
      'vitamin_a',
      'vitamin_c',
      'calcium',
      'iron',
      'glycemic_index',
    ];
    for (const field of nutritionOverrideFields) {
      if (entryData[field] !== undefined) {
        // @ts-expect-error TS(7053): Element implicitly has an 'any' type because expre... Remove this comment to see the full error message
        newSnapshotData[field] = entryData[field];
      }
    }
    if (entryData.custom_nutrients !== undefined) {
      newSnapshotData.custom_nutrients = sanitizeCustomNutrients(
        entryData.custom_nutrients
      );
    }
    const updatedEntry = await foodRepository.updateFoodEntry(
      entryId,
      authenticatedUserId,
      actingUserId,
      {
        ...entryData,
        meal_type_id: entryData.meal_type_id ?? existingEntry.meal_type_id,
        variant_id: variantIdToUse,
      }, // Ensure meal_type_id and correct variant_id are passed
      newSnapshotData // Pass the new snapshot data
    );
    if (!updatedEntry) {
      throw new Error('Food entry not found or not authorized to update.');
    }

    // Sync to MyFitnessPal if active
    mfpSyncService
      .syncDailyNutritionToMFP(authenticatedUserId, updatedEntry.entry_date)
      .catch((err: any) => {
        log(
          'warn',
          `[MFP SYNC] Real-time sync failed after updateFoodEntry: ${err.message}`
        );
      });

    return updatedEntry;
  } catch (error) {
    log(
      'error',
      `Error updating food entry ${entryId} by user ${authenticatedUserId} in foodService:`,
      error
    );
    throw error;
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function deleteFoodEntry(authenticatedUserId: any, entryId: any) {
  try {
    const entryOwnerId = await foodRepository.getFoodEntryOwnerId(
      entryId,
      authenticatedUserId
    );
    if (!entryOwnerId) {
      throw new Error('Food entry not found.');
    }
    // Authorization check: Ensure the authenticated user owns the entry
    // or has family access to the owner's data.
    // For simplicity, assuming direct ownership for now.
    if (entryOwnerId !== authenticatedUserId) {
      // In a real app, you'd check family access here.
      throw new Error(
        'Forbidden: You do not have permission to delete this food entry.'
      );
    }
    const success = await foodRepository.deleteFoodEntry(
      entryId,
      authenticatedUserId
    );
    if (!success) {
      throw new Error('Food entry not found or not authorized to delete.');
    }

    // Since we don't have the entry's date easily here without re-fetching,
    // we might need to fetch it or just sync "today".
    // But usually syncDailyNutritionToMFP is safe to call for any date.
    // For now, if it's a delete, we might just let the next sync handle it or use a default.
    // However, idempotency Cleanup in pushNutritionToMFP will handle deleted items.

    return true;
  } catch (error) {
    log(
      'error',
      `Error deleting food entry ${entryId} by user ${authenticatedUserId} in foodService:`,
      error
    );
    throw error;
  }
}
async function getFoodEntriesByDate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authenticatedUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  targetUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  selectedDate: any
) {
  try {
    if (!targetUserId) {
      log(
        'error',
        'getFoodEntriesByDate: targetUserId is undefined. Returning empty array.'
      );
      return [];
    }
    const entries = await foodRepository.getFoodEntriesByDate(
      targetUserId,
      selectedDate
    );
    return entries;
  } catch (error) {
    log(
      'error',
      `Error fetching food entries for user ${targetUserId} on ${selectedDate} by ${authenticatedUserId} in foodService:`,
      error
    );
    throw error;
  }
}
async function getFoodEntriesByDateRange(
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
    const entries = await foodRepository.getFoodEntriesByDateRange(
      targetUserId,
      startDate,
      endDate
    );
    return entries;
  } catch (error) {
    log(
      'error',
      `Error fetching food entries for user ${targetUserId} from ${startDate} to ${endDate} by ${authenticatedUserId} in foodService:`,
      error
    );
    throw error;
  }
}
async function copyFoodEntries(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authenticatedUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actingUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sourceDate: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sourceMealType: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  targetDate: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  targetMealType: any
) {
  try {
    log(
      'info',
      `copyFoodEntries: Copying from ${sourceDate} (${sourceMealType}) to ${targetDate} (${targetMealType}) for user ${authenticatedUserId}`
    );
    // 1. Fetch source entries
    const sourceEntries = await foodRepository.getFoodEntriesByDateAndMealType(
      authenticatedUserId,
      sourceDate,
      sourceMealType
    );
    if (sourceEntries.length === 0) {
      log(
        'debug',
        `No food entries found for ${sourceMealType} on ${sourceDate} for user ${authenticatedUserId}. No entries to copy.`
      );
      return [];
    }
    const targetMealTypeId = await resolveMealTypeId(
      authenticatedUserId,
      targetMealType
    );
    if (!targetMealTypeId) {
      throw new Error(`Invalid target meal type: ${targetMealType}`);
    }
    // Map to keep track of duplicated food_entry_meals
    // Key: old_food_entry_meal_id, Value: new_food_entry_meal_id
    const mealMapping = new Map();
    const entriesToCreate = [];
    for (const entry of sourceEntries) {
      log(
        'debug',
        `copyFoodEntries: Processing source entry: ${JSON.stringify(entry)}`
      );
      let newFoodEntryMealId = null;
      // If the entry belongs to a meal container, ensure the container is duplicated
      if (entry.food_entry_meal_id) {
        if (mealMapping.has(entry.food_entry_meal_id)) {
          newFoodEntryMealId = mealMapping.get(entry.food_entry_meal_id);
        } else {
          // Fetch the original meal details
          const originalMeal =
            await foodEntryMealRepository.getFoodEntryMealById(
              entry.food_entry_meal_id,
              authenticatedUserId
            );
          if (originalMeal) {
            // Create a new meal container for the target date/slot
            const newMeal = await foodEntryMealRepository.createFoodEntryMeal(
              {
                user_id: authenticatedUserId,
                meal_template_id: originalMeal.meal_template_id,
                meal_type_id: targetMealTypeId,
                entry_date: targetDate,
                name: originalMeal.name,
                description: originalMeal.description,
                quantity: originalMeal.quantity,
                unit: originalMeal.unit,
              },
              actingUserId
            );
            newFoodEntryMealId = newMeal.id;
            mealMapping.set(entry.food_entry_meal_id, newFoodEntryMealId);
            log(
              'debug',
              `copyFoodEntries: Duplicated meal container "${originalMeal.name}" (${entry.food_entry_meal_id} -> ${newFoodEntryMealId})`
            );
          }
        }
      }
      // Check for existing entry to prevent duplicates in the same meal/slot
      const existingEntry = await foodRepository.getFoodEntryByDetails(
        authenticatedUserId,
        entry.food_id,
        targetMealType,
        targetDate,
        entry.variant_id,
        newFoodEntryMealId // Use the new meal container ID for the duplicate check
      );
      if (!existingEntry) {
        entriesToCreate.push({
          user_id: authenticatedUserId,
          created_by_user_id: actingUserId,
          food_id: entry.food_id,
          meal_type_id: targetMealTypeId,
          food_entry_meal_id: newFoodEntryMealId, // Link the food to the new container
          quantity: entry.quantity,
          unit: entry.unit,
          entry_date: targetDate,
          variant_id: entry.variant_id,
          meal_plan_template_id: null,
          food_name: entry.food_name,
          brand_name: entry.brand_name,
          serving_size: entry.serving_size,
          serving_unit: entry.serving_unit,
          calories: entry.calories,
          protein: entry.protein,
          carbs: entry.carbs,
          fat: entry.fat,
          saturated_fat: entry.saturated_fat,
          polyunsaturated_fat: entry.polyunsaturated_fat,
          monounsaturated_fat: entry.monounsaturated_fat,
          trans_fat: entry.trans_fat,
          cholesterol: entry.cholesterol,
          sodium: entry.sodium,
          potassium: entry.potassium,
          dietary_fiber: entry.dietary_fiber,
          sugars: entry.sugars,
          vitamin_a: entry.vitamin_a,
          vitamin_c: entry.vitamin_c,
          calcium: entry.calcium,
          iron: entry.iron,
          glycemic_index: entry.glycemic_index,
          custom_nutrients: sanitizeCustomNutrients(entry.custom_nutrients),
        });
        log(
          'debug',
          `copyFoodEntries: Adding entry for food_id: ${entry.food_id} into meal_id: ${newFoodEntryMealId}`
        );
      } else {
        log(
          'debug',
          `Skipping duplicate food entry for food_id ${entry.food_id} in ${targetMealType} on ${targetDate}.`
        );
      }
    }
    if (entriesToCreate.length === 0) {
      log(
        'debug',
        'All food entries already exist in target slot. No new entries created.'
      );
      return [];
    }
    const newEntries = await foodRepository.bulkCreateFoodEntries(
      entriesToCreate,
      authenticatedUserId
    );
    return newEntries;
  } catch (error) {
    log(
      'error',
      `Error copying food entries for user ${authenticatedUserId} from ${sourceDate} ${sourceMealType} to ${targetDate} ${targetMealType}:`,
      error
    );
    throw error;
  }
}
async function copyFoodEntriesFromYesterday(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authenticatedUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actingUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mealType: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  targetDate: any
) {
  try {
    const [yearStr, monthStr, dayStr] = targetDate.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    const day = parseInt(dayStr, 10);
    if (isNaN(year) || isNaN(month) || isNaN(day)) {
      throw new Error('Invalid date format provided for targetDate.');
    }
    const priorDay = new Date(Date.UTC(year, month - 1, day));
    priorDay.setUTCDate(priorDay.getUTCDate() - 1);
    const sourceDate = priorDay.toISOString().split('T')[0];
    log(
      'info',
      `copyFoodEntriesFromYesterday: Calculating sourceDate ${sourceDate} from targetDate ${targetDate}`
    );
    // Delegate to consolidated copyFoodEntries function
    return await copyFoodEntries(
      authenticatedUserId,
      actingUserId,
      sourceDate,
      mealType,
      targetDate,
      mealType
    );
  } catch (error) {
    log(
      'error',
      `Error copying food entries from prior day for user ${authenticatedUserId} to ${targetDate} ${mealType}:`,
      error
    );
    throw error;
  }
}
async function copyAllFoodEntries(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authenticatedUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actingUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sourceDate: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  targetDate: any
) {
  try {
    log(
      'info',
      `copyAllFoodEntries: Copying entire day from ${sourceDate} to ${targetDate} for user ${authenticatedUserId}`
    );
    // 1. Fetch all entries from the source day to find used meal slots
    const allSourceEntries = await foodRepository.getFoodEntriesByDate(
      authenticatedUserId,
      sourceDate
    );
    if (allSourceEntries.length === 0) {
      log(
        'debug',
        `No food entries found on ${sourceDate} for user ${authenticatedUserId}. Nothing to copy.`
      );
      return [];
    }
    // 2. Identify unique meal types (slots) that have data
    const usedMealTypes = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...new Set(allSourceEntries.map((e: any) => e.meal_type)),
    ];
    log(
      'debug',
      `copyAllFoodEntries: Found ${usedMealTypes.length} slots with data: ${usedMealTypes.join(', ')}`
    );
    const allCopiedEntries = [];
    // 3. Loop through each slot and perform a Deep Copy
    for (const mealType of usedMealTypes) {
      const copiedEntries = await copyFoodEntries(
        authenticatedUserId,
        actingUserId,
        sourceDate,
        mealType,
        targetDate,
        mealType
      );
      allCopiedEntries.push(...copiedEntries);
    }
    log(
      'info',
      `Successfully copied entire day (${allCopiedEntries.length} entries) from ${sourceDate} to ${targetDate} for user ${authenticatedUserId}.`
    );
    return allCopiedEntries;
  } catch (error) {
    log(
      'error',
      `Error copying all food entries for user ${authenticatedUserId} from ${sourceDate} to ${targetDate}:`,
      error
    );
    throw error;
  }
}
async function copyAllFoodEntriesFromYesterday(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authenticatedUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actingUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  targetDate: any
) {
  try {
    const [yearStr, monthStr, dayStr] = targetDate.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    const day = parseInt(dayStr, 10);
    if (isNaN(year) || isNaN(month) || isNaN(day)) {
      throw new Error('Invalid date format provided for targetDate.');
    }
    const priorDay = new Date(Date.UTC(year, month - 1, day));
    priorDay.setUTCDate(priorDay.getUTCDate() - 1);
    const sourceDate = priorDay.toISOString().split('T')[0];
    return await copyAllFoodEntries(
      authenticatedUserId,
      actingUserId,
      sourceDate,
      targetDate
    );
  } catch (error) {
    log(
      'error',
      `Error copying all food entries from prior day for user ${authenticatedUserId} to ${targetDate}:`,
      error
    );
    throw error;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getDailyNutritionByCategory(userId: any, date: any) {
  return await foodRepository.getDailyNutritionByCategory(userId, date);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getDailyNutritionSummary(userId: any, date: any) {
  try {
    const summary = await foodRepository.getDailyNutritionSummary(userId, date);
    if (!summary) {
      // Return a zero-initialized summary if no entries are found for the date
      return {
        total_calories: 0,
        total_protein: 0,
        total_carbs: 0,
        total_fat: 0,
        total_dietary_fiber: 0,
      };
    }
    return summary;
  } catch (error) {
    log(
      'error',
      `Error fetching daily nutrition summary for user ${userId} on ${date} in foodService:`,
      error
    );
    throw error;
  }
}
// New functions for food_entry_meals logic
async function createFoodEntryMeal(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authenticatedUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actingUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mealData: any
) {
  log(
    'info',
    `createFoodEntryMeal in foodEntryService: authenticatedUserId: ${authenticatedUserId}, actingUserId: ${actingUserId}, mealData: ${JSON.stringify(mealData)}`
  );
  try {
    // 1. Create the parent food_entry_meals record with quantity and unit
    const newFoodEntryMeal = await foodEntryMealRepository.createFoodEntryMeal(
      {
        user_id: mealData.user_id || authenticatedUserId, // Use target user ID
        meal_template_id: mealData.meal_template_id || null,
        meal_type_id: mealData.meal_type_id || null,
        meal_type: mealData.meal_type,
        entry_date: mealData.entry_date,
        name: mealData.name,
        description: mealData.description,
        quantity: mealData.quantity || 1.0, // Default to 1.0
        unit: mealData.unit || 'serving', // Default to 'serving'
      },
      actingUserId
    );
    const resolvedMealTypeId = newFoodEntryMeal.meal_type_id;
    let foodsToProcess = mealData.foods || [];
    let mealServingSize = 1.0; // Default serving size
    // If a meal_template id is provided fetch the template for serving size
    if (mealData.meal_template_id) {
      log(
        'info',
        `Fetching meal template ${mealData.meal_template_id} for serving size and foods.`
      );
      const mealTemplate = await mealService.getMealById(
        authenticatedUserId,
        mealData.meal_template_id
      );
      if (mealTemplate) {
        mealServingSize = mealTemplate.serving_size || 1.0; // Always get the meal serving size
        log(
          'info',
          `Meal template serving size: ${mealServingSize} ${mealTemplate.serving_unit || 'serving'}`
        );
        // If no specific foods provided use template
        if (!mealData.foods || mealData.foods.length === 0) {
          if (mealTemplate.foods) {
            foodsToProcess = mealTemplate.foods;
          } else {
            log(
              'warn',
              `Meal template ${mealData.meal_template_id} has no foods.`
            );
          }
        }
      } else {
        log(
          'warn',
          `Meal template ${mealData.meal_template_id} not found when creating food entry meal.`
        );
        // Continue without template data
      }
    }
    // Calculate portion multiplier: consumed_quantity / meal_serving_size
    const consumedQuantity = mealData.quantity || 1.0;
    let multiplier = 1.0;
    //Scale if there is a template ID
    if (mealData.meal_template_id) {
      if (mealData.unit === 'serving') {
        multiplier = consumedQuantity;
      } else {
        multiplier = consumedQuantity / mealServingSize;
      }
    }
    log(
      'info',
      `Portion multiplier: ${multiplier} (consumed: ${consumedQuantity}, serving_size: ${mealServingSize}, has_template: ${!!mealData.meal_template_id})`
    );
    // 2. Create component food_entries records with scaled quantities
    const entriesToCreate = [];
    for (const foodItem of foodsToProcess) {
      const food = await foodRepository.getFoodById(
        foodItem.food_id,
        authenticatedUserId
      );
      if (!food) {
        log(
          'warn',
          `Food with ID ${foodItem.food_id} not found when creating food entry meal. Skipping.`
        );
        continue;
      }
      const variant = await foodRepository.getFoodVariantById(
        foodItem.variant_id,
        authenticatedUserId
      );
      if (!variant) {
        log(
          'warn',
          `Food variant with ID ${foodItem.variant_id} not found for food ${foodItem.food_id} when creating food entry meal. Skipping.`
        );
        continue;
      }
      const snapshot = {
        food_name: food.name,
        brand_name: food.brand,
        serving_size: variant.serving_size,
        serving_unit: variant.serving_unit,
        calories: variant.calories,
        protein: variant.protein,
        carbs: variant.carbs,
        fat: variant.fat,
        saturated_fat: variant.saturated_fat,
        polyunsaturated_fat: variant.polyunsaturated_fat,
        monounsaturated_fat: variant.monounsaturated_fat,
        trans_fat: variant.trans_fat,
        cholesterol: variant.cholesterol,
        sodium: variant.sodium,
        potassium: variant.potassium,
        dietary_fiber: variant.dietary_fiber,
        sugars: variant.sugars,
        vitamin_a: variant.vitamin_a,
        vitamin_c: variant.vitamin_c,
        calcium: variant.calcium,
        iron: variant.iron,
        glycemic_index: variant.glycemic_index,
        custom_nutrients: sanitizeCustomNutrients(variant.custom_nutrients),
      };
      // Note: We are deliberatly NOT applying inline overrides here for meal components.
      // Scaling nutrition based on multiplier
      const scaleNutrition = (val: any) =>
        val !== null ? parseFloat((val * multiplier).toFixed(4)) : null;
      entriesToCreate.push({
        user_id: mealData.user_id || authenticatedUserId,
        food_id: foodItem.food_id,
        meal_type_id: resolvedMealTypeId,
        quantity: scaleNutrition(variant.serving_size), // Scale serving quantity
        unit: variant.serving_unit,
        entry_date: mealData.entry_date,
        variant_id: foodItem.variant_id,
        created_by_user_id: actingUserId,
        food_entry_meal_id: newFoodEntryMeal.id, // Reference to parent meal
        // Scaled snapshot data
        food_name: snapshot.food_name,
        brand_name: snapshot.brand_name,
        serving_size: snapshot.serving_size,
        serving_unit: snapshot.serving_unit,
        calories: scaleNutrition(snapshot.calories),
        protein: scaleNutrition(snapshot.protein),
        carbs: scaleNutrition(snapshot.carbs),
        fat: scaleNutrition(snapshot.fat),
        saturated_fat: scaleNutrition(snapshot.saturated_fat),
        polyunsaturated_fat: scaleNutrition(snapshot.polyunsaturated_fat),
        monounsaturated_fat: scaleNutrition(snapshot.monounsaturated_fat),
        trans_fat: scaleNutrition(snapshot.trans_fat),
        cholesterol: scaleNutrition(snapshot.cholesterol),
        sodium: scaleNutrition(snapshot.sodium),
        potassium: scaleNutrition(snapshot.potassium),
        dietary_fiber: scaleNutrition(snapshot.dietary_fiber),
        sugars: scaleNutrition(snapshot.sugars),
        vitamin_a: scaleNutrition(snapshot.vitamin_a),
        vitamin_c: scaleNutrition(snapshot.vitamin_c),
        calcium: scaleNutrition(snapshot.calcium),
        iron: scaleNutrition(snapshot.iron),
        glycemic_index: snapshot.glycemic_index,
        custom_nutrients: sanitizeCustomNutrients(snapshot.custom_nutrients),
      });
    }
    if (entriesToCreate.length > 0) {
      await foodRepository.bulkCreateFoodEntries(
        entriesToCreate,
        authenticatedUserId
      );
    }
    // 3. Return the created food_entry_meal (with calculated totals)
    return await foodEntryMealRepository.getFoodEntryMealById(
      newFoodEntryMeal.id,
      authenticatedUserId
    );
  } catch (error) {
    log('error', 'Error in createFoodEntryMeal:', error);
    throw error;
  }
}
async function updateFoodEntryMeal(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authenticatedUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actingUserId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  foodEntryMealId: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mealData: any
) {
  log(
    'info',
    `updateFoodEntryMeal in foodEntryService: authenticatedUserId: ${authenticatedUserId}, actingUserId: ${actingUserId}, foodEntryMealId: ${foodEntryMealId}, mealData: ${JSON.stringify(mealData)}`
  );
  try {
    const existingMeal = await foodEntryMealRepository.getFoodEntryMealById(
      foodEntryMealId,
      authenticatedUserId
    );
    if (!existingMeal) {
      throw new Error('Food entry meal not found.');
    }
    // Update parent record
    await foodEntryMealRepository.updateFoodEntryMeal(
      foodEntryMealId,
      mealData,
      actingUserId
    );
    // If quantity was updated, we need to rescale all component food entries
    if (mealData.quantity !== undefined && mealData.quantity !== null) {
      const components =
        await foodRepository.getFoodEntryComponentsByFoodEntryMealId(
          foodEntryMealId,
          authenticatedUserId
        );
      if (components.length > 0) {
        // Calculate new multiplier
        // If we have a meal_template_id, use template's serving size. Otherwise assumes 1.0.
        let mealServingSize = 1.0;
        if (existingMeal.meal_template_id) {
          const template = await mealService.getMealById(
            authenticatedUserId,
            existingMeal.meal_template_id
          );
          if (template) {
            mealServingSize = template.serving_size || 1.0;
          }
        }
        const newMultiplier = mealData.quantity / mealServingSize;
        const oldMultiplier = existingMeal.quantity / mealServingSize;
        const ratio = newMultiplier / oldMultiplier;
        const scale = (val: any) =>
          val !== null ? parseFloat((val * ratio).toFixed(4)) : null;
        for (const component of components) {
          await foodRepository.updateFoodEntry(
            component.id,
            authenticatedUserId,
            actingUserId,
            {
              quantity: scale(component.quantity),
              entry_date: mealData.entry_date || existingMeal.entry_date,
              meal_type_id: mealData.meal_type_id || existingMeal.meal_type_id,
            },
            {
              // Rescale snapshot nutrition values
              food_name: component.food_name,
              brand_name: component.brand_name,
              serving_size: component.serving_size,
              serving_unit: component.serving_unit,
              calories: scale(component.calories),
              protein: scale(component.protein),
              carbs: scale(component.carbs),
              fat: scale(component.fat),
              saturated_fat: scale(component.saturated_fat),
              polyunsaturated_fat: scale(component.polyunsaturated_fat),
              monounsaturated_fat: scale(component.monounsaturated_fat),
              trans_fat: scale(component.trans_fat),
              cholesterol: scale(component.cholesterol),
              sodium: scale(component.sodium),
              potassium: scale(component.potassium),
              dietary_fiber: scale(component.dietary_fiber),
              sugars: scale(component.sugars),
              vitamin_a: scale(component.vitamin_a),
              vitamin_c: scale(component.vitamin_c),
              calcium: scale(component.calcium),
              iron: scale(component.iron),
              glycemic_index: component.glycemic_index,
              custom_nutrients: component.custom_nutrients,
            }
          );
        }
      }
    } else if (
      mealData.entry_date !== undefined ||
      mealData.meal_type_id !== undefined
    ) {
      // resync headers only (date/slot)
      const components =
        await foodRepository.getFoodEntryComponentsByFoodEntryMealId(
          foodEntryMealId,
          authenticatedUserId
        );
      for (const component of components) {
        await foodRepository.updateFoodEntry(
          component.id,
          authenticatedUserId,
          actingUserId,
          {
            entry_date: mealData.entry_date || component.entry_date,
            meal_type_id: mealData.meal_type_id || component.meal_type_id,
          },
          component // preserve snapshot as-is
        );
      }
    }
    return await foodEntryMealRepository.getFoodEntryMealById(
      foodEntryMealId,
      authenticatedUserId
    );
  } catch (error) {
    log('error', 'Error in updateFoodEntryMeal:', error);
    throw error;
  }
}
async function deleteFoodEntryMeal(authenticatedUserId: any, mealId: any) {
  log(
    'info',
    `deleteFoodEntryMeal in foodEntryService: authenticatedUserId: ${authenticatedUserId}, mealId: ${mealId}`
  );
  try {
    const success = await foodEntryMealRepository.deleteFoodEntryMeal(
      mealId,
      authenticatedUserId
    );
    if (!success) {
      throw new Error('Food entry meal not found or not authorized to delete.');
    }
    return true;
  } catch (error) {
    log('error', 'Error in deleteFoodEntryMeal:', error);
    throw error;
  }
}
export {
  getGlycemicIndexValue,
  getGlycemicIndexCategory,
  resolveMealTypeId,
  createFoodEntry,
  updateFoodEntry,
  deleteFoodEntry,
  getFoodEntriesByDate,
  getFoodEntriesByDateRange,
  copyFoodEntries,
  copyFoodEntriesFromYesterday,
  copyAllFoodEntries,
  copyAllFoodEntriesFromYesterday,
  getDailyNutritionByCategory,
  getDailyNutritionSummary,
  createFoodEntryMeal,
  updateFoodEntryMeal,
  deleteFoodEntryMeal,
};
export default {
  getGlycemicIndexValue,
  getGlycemicIndexCategory,
  resolveMealTypeId,
  createFoodEntry,
  updateFoodEntry,
  deleteFoodEntry,
  getFoodEntriesByDate,
  getFoodEntriesByDateRange,
  copyFoodEntries,
  copyFoodEntriesFromYesterday,
  copyAllFoodEntries,
  copyAllFoodEntriesFromYesterday,
  getDailyNutritionByCategory,
  getDailyNutritionSummary,
  createFoodEntryMeal,
  updateFoodEntryMeal,
  deleteFoodEntryMeal,
};
