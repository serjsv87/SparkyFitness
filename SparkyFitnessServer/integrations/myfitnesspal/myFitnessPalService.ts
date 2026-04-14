import axios from 'axios';
import { log } from '../../config/logging.js';
import { getExternalDataProviderByUserIdAndProviderName } from '../../models/externalProviderRepository.js';

/** Maximum concurrent DELETE requests during idempotency cleanup */
const DELETE_CONCURRENCY = 5;

interface MFPProvider {
  app_id: string;
  app_key: string;
}

export interface MFPCategoryData {
  calories: number;
  protein: number;
  fat: number;
  carbohydrate: number;
  sugars?: number;
  sodium?: number;
  fiber?: number;
}

export interface MFPNutritionData {
  date: string; // YYYY-MM-DD
  categories: { [key: string]: MFPCategoryData };
}

interface MFPSession {
  authHeaders: Record<string, string>;
  mfpUserId: string;
}

/**
 * Internal helper to authenticate with MyFitnessPal and get a session.
 */
async function getMFPSession(userId: string): Promise<MFPSession | null> {
  const mfpProvider = (await getExternalDataProviderByUserIdAndProviderName(
    userId,
    'myfitnesspal'
  )) as MFPProvider | null;

  if (!mfpProvider || !mfpProvider.app_key) {
    return null;
  }

  const cookiesStr = mfpProvider.app_key;
  const initialCsrfToken = mfpProvider.app_id || '';
  let currentCookies = cookiesStr;

  const baseHeaders = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'ru,uk;q=0.9,en-US;q=0.8,en;q=0.7',
    'content-type': 'application/json',
    origin: 'https://www.myfitnesspal.com',
    referer: 'https://www.myfitnesspal.com/ru/food/diary',
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    'x-requested-with': 'XMLHttpRequest',
  };

  // 1. Fetch CSRF
  let freshCsrfToken = initialCsrfToken;
  try {
    const csrfResp = await axios.get(
      'https://www.myfitnesspal.com/api/auth/csrf',
      {
        headers: { ...baseHeaders, Cookie: currentCookies },
      }
    );
    if (csrfResp.data && csrfResp.data.csrfToken) {
      freshCsrfToken = csrfResp.data.csrfToken;
    }
    const setCookie = csrfResp.headers['set-cookie'];
    if (setCookie) {
      const newCookies = setCookie.map((c) => c.split(';')[0]).join('; ');
      currentCookies = `${currentCookies}; ${newCookies}`;
    }
  } catch (error: unknown) {
    log(
      'warn',
      `MFP getSession: CSRF fetch fallback for ${userId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // 2. Fetch Bearer Token
  let bearerToken: string;
  let mfpUserId: string;
  try {
    const authResp = await axios.get(
      'https://www.myfitnesspal.com/user/auth_token',
      {
        headers: {
          ...baseHeaders,
          Cookie: currentCookies,
          'x-csrf-token': freshCsrfToken,
          'csrf-token': freshCsrfToken,
          'mfp-client-id': 'mfp-main-js',
        },
      }
    );

    if (authResp.data && authResp.data.access_token) {
      bearerToken = authResp.data.access_token;
      mfpUserId = authResp.data.user_id;
    } else {
      throw new Error('Access token missing.');
    }
  } catch (error: unknown) {
    log(
      'error',
      `MFP getSession: Auth failed for ${userId}: ${error instanceof Error ? error.message : String(error)}`
    );
    throw new Error('Authentication failed', { cause: error });
  }

  return {
    authHeaders: {
      ...baseHeaders,
      Authorization: `Bearer ${bearerToken}`,
      'mfp-client-id': 'mfp-main-js',
      Cookie: currentCookies,
      'x-csrf-token': freshCsrfToken,
      ...(mfpUserId ? { 'mfp-user-id': String(mfpUserId) } : {}),
    },
    mfpUserId: String(mfpUserId),
  };
}

/**
 * Pushes nutrition data to MyFitnessPal.
 */
export async function pushNutritionToMFP(
  userId: string,
  data: MFPNutritionData
) {
  try {
    const session = await getMFPSession(userId);
    if (!session) {
      log(
        'info',
        `pushNutritionToMFP: No credentials for ${userId}. Skipping.`
      );
      return null;
    }
    const { authHeaders } = session;

    // Idempotency - Delete existing entries
    try {
      const discoveryUrl = `https://api.myfitnesspal.com/v2/diary?entry_date=${data.date}&types=diary_meal,food_entry`;
      log(
        'info',
        `pushNutritionToMFP: Finding existing entries for ${data.date} for user ${userId}`
      );
      let diaryResp;
      try {
        diaryResp = await axios.get(discoveryUrl, { headers: authHeaders });
      } catch (error: unknown) {
        log(
          'warn',
          `pushNutritionToMFP: Discovery via types failed, retrying without types: ${error instanceof Error ? error.message : String(error)}`
        );
        diaryResp = await axios.get(
          `https://api.myfitnesspal.com/v2/diary?entry_date=${data.date}`,
          { headers: authHeaders }
        );
      }

      if (diaryResp.data && Array.isArray(diaryResp.data.items)) {
        const items = diaryResp.data.items;
        const itemsWithId = items.filter(
          (item: { id?: string; item_id?: string; type?: string }) =>
            (item.id || item.item_id) &&
            (item.type === 'quick_add' || item.type === 'food_entry')
        );

        if (itemsWithId.length > 0) {
          log(
            'info',
            `pushNutritionToMFP: Found ${itemsWithId.length} entries to cleanup.`
          );
          for (let i = 0; i < itemsWithId.length; i += DELETE_CONCURRENCY) {
            const batch = itemsWithId.slice(i, i + DELETE_CONCURRENCY);
            await Promise.all(
              batch.map(async (item: { id?: string; item_id?: string }) => {
                const itemId = item.id || item.item_id;
                try {
                  await axios.delete(
                    `https://api.myfitnesspal.com/v2/diary/${itemId}`,
                    {
                      headers: authHeaders,
                    }
                  );
                } catch {
                  /* ignore deletion errors for individual items */
                }
              })
            );
          }
        }
      }
    } catch (error: unknown) {
      log(
        'warn',
        `pushNutritionToMFP: Cleanup failed for user ${userId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Push categories
    const responses = [];
    const mealMapping: Record<string, string> = {
      breakfast: 'Breakfast',
      lunch: 'Lunch',
      dinner: 'Dinner',
      snacks: 'Snacks',
    };

    const categoryEntries = Object.entries(data.categories);
    log(
      'info',
      `pushNutritionToMFP: Pushing ${categoryEntries.length} nutrition categories for ${data.date}`
    );

    for (const [categoryName, categoryData] of categoryEntries) {
      if (categoryData.calories <= 0) continue;
      const mfpMealName = mealMapping[categoryName.toLowerCase()] || 'Snacks';
      const payload = {
        items: [
          {
            type: 'quick_add',
            date: data.date,
            meal_name: mfpMealName,
            nutritional_contents: {
              energy: {
                unit: 'calories',
                value: Math.round(categoryData.calories),
              },
              carbohydrates: Number(categoryData.carbohydrate),
              fat: Number(categoryData.fat),
              protein: Number(categoryData.protein),
              sugar:
                categoryData.sugars !== undefined
                  ? Number(categoryData.sugars)
                  : undefined,
              sodium:
                categoryData.sodium !== undefined
                  ? Number(categoryData.sodium)
                  : undefined,
              fiber:
                categoryData.fiber !== undefined
                  ? Number(categoryData.fiber)
                  : undefined,
            },
          },
        ],
      };

      log(
        'info',
        `pushNutritionToMFP: Syncing ${mfpMealName}: ${Math.round(categoryData.calories)} kcal`
      );
      log('debug', `pushNutritionToMFP: Payload: ${JSON.stringify(payload)}`);

      const finalResp = await axios.post(
        'https://api.myfitnesspal.com/v2/diary',
        payload,
        {
          headers: authHeaders,
        }
      );
      if (finalResp.status < 400) {
        log(
          'info',
          `pushNutritionToMFP: Successfully synced ${mfpMealName}. Status: ${finalResp.status}`
        );
        responses.push(finalResp.data);
      }
    }

    return { status: 'success', date: data.date, responses };
  } catch (error: any) {
    if (error.response?.data) {
      log(
        'error',
        `pushNutritionToMFP: Error details: ${JSON.stringify(error.response.data)}`
      );
    }
    log(
      'error',
      `pushNutritionToMFP: Fatal error for user ${userId}:`,
      error.message
    );
    throw error;
  }
}

/**
 * Pushes water intake to MyFitnessPal.
 */
export async function pushWaterToMFP(
  userId: string,
  date: string,
  milliliters: number
) {
  try {
    const session = await getMFPSession(userId);
    if (!session) return null;
    const { authHeaders } = session;

    const targetUrl = 'https://api.myfitnesspal.com/v2/diary/water';

    const payload = {
      date: date,
      units: 'milliliters',
      value: Math.round(milliliters),
    };

    log('info', `pushWaterToMFP: Sending request to ${targetUrl}`);
    log('info', `pushWaterToMFP: Payload: ${JSON.stringify(payload)}`);

    try {
      const resp = await axios.post(targetUrl, payload, {
        headers: authHeaders,
      });
      log('info', `pushWaterToMFP: Success! Status: ${resp.status}`);
      return resp.data;
    } catch (error: any) {
      if (error.response?.data) {
        log(
          'info',
          `pushWaterToMFP: POST failed with data: ${JSON.stringify(error.response.data)}`
        );
      }
      throw error;
    }
  } catch (error: any) {
    if (error.response?.data) {
      log(
        'error',
        `pushWaterToMFP: Fatal error details: ${JSON.stringify(error.response.data)}`
      );
    }
    log(
      'error',
      `pushWaterToMFP: Fatal error for user ${userId}:`,
      error.message
    );
    throw error;
  }
}
