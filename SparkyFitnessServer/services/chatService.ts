import chatRepository, {
  AiServiceSetting,
  ChatHistoryEntry,
} from '../models/chatRepository.js';
import measurementRepository from '../models/measurementRepository.js';
import { log } from '../config/logging.js';
import { getDefaultModel } from '../ai/config.js';
import undici from 'undici';
import { loadUserTimezone } from '../utils/timezoneLoader.js';
import { todayInZone } from '@workspace/shared';

const { Agent } = undici;

interface AiUsageStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimated: boolean;
}

export interface ChatMessagePart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatMessagePart[];
}

function extractAiUsageStats(
  serviceType: string,
  data: Record<string, unknown>
): AiUsageStats | null {
  const toNumber = (value: unknown): number | null => {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };

  if (!data || typeof data !== 'object') {
    return null;
  }

  if (
    serviceType === 'openai' ||
    serviceType === 'openai_compatible' ||
    serviceType === 'mistral' ||
    serviceType === 'groq' ||
    serviceType === 'openrouter' ||
    serviceType === 'custom'
  ) {
    const usage = (data.usage as Record<string, unknown>) || {};
    const inputTokens = toNumber(usage.prompt_tokens);
    const outputTokens = toNumber(usage.completion_tokens);
    const totalTokens = toNumber(usage.total_tokens);
    if (inputTokens !== null || outputTokens !== null || totalTokens !== null) {
      const input = inputTokens ?? 0;
      const output = outputTokens ?? 0;
      return {
        inputTokens: input,
        outputTokens: output,
        totalTokens: totalTokens ?? input + output,
        estimated: false,
      };
    }
  }

  if (serviceType === 'anthropic') {
    const usage = (data.usage as Record<string, unknown>) || {};
    const inputTokens = toNumber(usage.input_tokens);
    const outputTokens = toNumber(usage.output_tokens);
    if (inputTokens !== null || outputTokens !== null) {
      const input = inputTokens ?? 0;
      const output = outputTokens ?? 0;
      return {
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output,
        estimated: false,
      };
    }
  }

  if (serviceType === 'google') {
    const usageMetadata = (data.usageMetadata as Record<string, unknown>) || {};
    const inputTokens = toNumber(usageMetadata.promptTokenCount);
    const outputTokens = toNumber(usageMetadata.candidatesTokenCount);
    const totalTokens = toNumber(usageMetadata.totalTokenCount);
    if (inputTokens !== null || outputTokens !== null || totalTokens !== null) {
      const input = inputTokens ?? 0;
      const output = outputTokens ?? 0;
      return {
        inputTokens: input,
        outputTokens: output,
        totalTokens: totalTokens ?? input + output,
        estimated: false,
      };
    }
  }

  if (serviceType === 'ollama') {
    const inputTokens = toNumber(data.prompt_eval_count);
    const outputTokens = toNumber(data.eval_count);
    if (inputTokens !== null || outputTokens !== null) {
      const input = inputTokens ?? 0;
      const output = outputTokens ?? 0;
      return {
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output,
        estimated: false,
      };
    }
  }

  return null;
}

function estimateAiUsageStats(
  messages: ChatMessage[] | any[],
  content: string
): AiUsageStats {
  const promptChars = JSON.stringify(messages ?? []).length;
  const outputChars = (content || '').length;
  const inputTokens = Math.max(1, Math.round(promptChars / 4));
  const outputTokens = Math.max(1, Math.round(outputChars / 4));
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimated: true,
  };
}

export async function handleAiServiceSettings(
  action: string,
  serviceData: Partial<AiServiceSetting>,
  authenticatedUserId: string
) {
  try {
    if (action === 'save_ai_service_settings') {
      serviceData.user_id = authenticatedUserId; // Ensure user_id is set from authenticated user
      const result = await chatRepository.upsertAiServiceSetting(
        serviceData as AiServiceSetting
      );
      if (!result) {
        throw new Error('AI service setting not found.');
      }
      const {
        encrypted_api_key: _enc,
        api_key_iv: _iv,
        api_key_tag: _tag,
        ...safeSetting
      } = result;
      return {
        message: 'AI service settings saved successfully.',
        setting: safeSetting,
      };
    }
    throw new Error('Unsupported action for AI service settings.');
  } catch (error: unknown) {
    log(
      'error',
      `Error handling AI service settings for user ${authenticatedUserId}:`,
      error
    );
    throw error;
  }
}

export async function getAiServiceSettings(
  authenticatedUserId: string,
  targetUserId: string
) {
  try {
    const settings =
      await chatRepository.getAiServiceSettingsByUserId(targetUserId);
    return settings || [];
  } catch (error: unknown) {
    log(
      'error',
      `Error fetching AI service settings for user ${targetUserId} by ${authenticatedUserId}:`,
      error
    );
    return [];
  }
}

export async function getActiveAiServiceSetting(
  authenticatedUserId: string,
  targetUserId: string
) {
  try {
    const setting =
      await chatRepository.getActiveAiServiceSetting(targetUserId);
    if (setting) {
      const source = setting.source || 'unknown';
      log(
        'info',
        `Active AI service setting for user ${targetUserId} (source: ${source})`
      );
    }
    return setting;
  } catch (error: unknown) {
    log(
      'error',
      `Error fetching active AI service setting for user ${targetUserId} by ${authenticatedUserId}:`,
      error
    );
    return null;
  }
}

export async function deleteAiServiceSetting(
  authenticatedUserId: string,
  id: string
) {
  try {
    const setting = await chatRepository.getAiServiceSettingById(
      id,
      authenticatedUserId
    );
    if (!setting) {
      throw new Error('AI service setting not found.');
    }
    const success = await chatRepository.deleteAiServiceSetting(
      id,
      authenticatedUserId
    );
    if (!success) {
      throw new Error('AI service setting not found.');
    }
    return { message: 'AI service setting deleted successfully.' };
  } catch (error: unknown) {
    log(
      'error',
      `Error deleting AI service setting ${id} by ${authenticatedUserId}:`,
      error
    );
    throw error;
  }
}

export async function clearOldChatHistory(authenticatedUserId: string) {
  try {
    await chatRepository.clearOldChatHistory(authenticatedUserId);
    return { message: 'Old chat history cleared successfully.' };
  } catch (error: unknown) {
    log(
      'error',
      `Error clearing old chat history for user ${authenticatedUserId}:`,
      error
    );
    throw error;
  }
}

export async function getSparkyChatHistory(
  authenticatedUserId: string,
  targetUserId: string
) {
  try {
    const history = await chatRepository.getChatHistoryByUserId(targetUserId);
    return history as ChatHistoryEntry[];
  } catch (error: unknown) {
    log(
      'error',
      `Error fetching chat history for user ${targetUserId} by ${authenticatedUserId}:`,
      error
    );
    throw error;
  }
}

export async function getSparkyChatHistoryEntry(
  authenticatedUserId: string,
  id: string
) {
  try {
    const entryOwnerId = await chatRepository.getChatHistoryEntryOwnerId(
      id,
      authenticatedUserId
    );
    if (!entryOwnerId) {
      throw new Error('Chat history entry not found.');
    }
    const entry = await chatRepository.getChatHistoryEntryById(
      id,
      authenticatedUserId
    );
    return entry as ChatHistoryEntry | null;
  } catch (error: unknown) {
    log(
      'error',
      `Error fetching chat history entry ${id} by ${authenticatedUserId}:`,
      error
    );
    throw error;
  }
}

export async function updateSparkyChatHistoryEntry(
  authenticatedUserId: string,
  id: string,
  updateData: Record<string, unknown>
) {
  try {
    const entryOwnerId = await chatRepository.getChatHistoryEntryOwnerId(
      id,
      authenticatedUserId
    );
    if (!entryOwnerId) {
      throw new Error('Chat history entry not found.');
    }
    if (entryOwnerId !== authenticatedUserId) {
      throw new Error(
        'Forbidden: You do not have permission to update this chat history entry.'
      );
    }
    const updatedEntry = await chatRepository.updateChatHistoryEntry(
      id,
      authenticatedUserId,
      updateData
    );
    if (!updatedEntry) {
      throw new Error(
        'Chat history entry not found or not authorized to update.'
      );
    }
    return updatedEntry;
  } catch (error: unknown) {
    log(
      'error',
      `Error updating chat history entry ${id} by ${authenticatedUserId}:`,
      error
    );
    throw error;
  }
}

export async function deleteSparkyChatHistoryEntry(
  authenticatedUserId: string,
  id: string
) {
  try {
    const entryOwnerId = await chatRepository.getChatHistoryEntryOwnerId(
      id,
      authenticatedUserId
    );
    if (!entryOwnerId) {
      throw new Error('Chat history entry not found.');
    }
    if (entryOwnerId !== authenticatedUserId) {
      throw new Error(
        'Forbidden: You do not have permission to delete this chat history entry.'
      );
    }
    const success = await chatRepository.deleteChatHistoryEntry(
      id,
      authenticatedUserId
    );
    if (!success) {
      throw new Error('Chat history entry not found.');
    }
    return { message: 'Chat history entry deleted successfully.' };
  } catch (error: unknown) {
    log(
      'error',
      `Error deleting chat history entry ${id} by ${authenticatedUserId}:`,
      error
    );
    throw error;
  }
}

export async function clearAllSparkyChatHistory(authenticatedUserId: string) {
  try {
    await chatRepository.clearAllChatHistory(authenticatedUserId);
    return { message: 'All chat history cleared successfully.' };
  } catch (error: unknown) {
    log(
      'error',
      `Error clearing all chat history for user ${authenticatedUserId}:`,
      error
    );
    throw error;
  }
}

export async function saveSparkyChatHistory(
  authenticatedUserId: string,
  historyData: {
    user_id?: string;
    content: string;
    messageType: string;
    metadata?: Record<string, unknown>;
  }
) {
  try {
    historyData.user_id = authenticatedUserId;
    await chatRepository.saveChatMessage(
      historyData.user_id,
      historyData.content,
      historyData.messageType,
      historyData.metadata
    );
    return { message: 'Chat history saved successfully.' };
  } catch (error: unknown) {
    log(
      'error',
      `Error saving chat history for user ${authenticatedUserId}:`,
      error
    );
    throw error;
  }
}

export async function processChatMessage(
  messages: ChatMessage[],
  serviceConfigId: string,
  authenticatedUserId: string
) {
  try {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('Invalid messages format.');
    }
    if (!serviceConfigId) {
      throw new Error('AI service configuration ID is missing.');
    }

    const aiService = await chatRepository.getAiServiceSettingForBackend(
      serviceConfigId,
      authenticatedUserId
    );
    if (!aiService) {
      throw new Error('AI service setting not found for the provided ID.');
    }

    const source = aiService.source || 'unknown';
    log(
      'info',
      `Processing chat message for user ${authenticatedUserId} using AI service from ${source} (ID: ${serviceConfigId})`
    );

    if (aiService.service_type !== 'ollama' && !aiService.api_key) {
      throw new Error('API key missing for selected AI service.');
    }

    let response;
    const model =
      aiService.model_name || getDefaultModel(aiService.service_type);

    const [customCategories, chatTz] = await Promise.all([
      measurementRepository.getCustomCategories(authenticatedUserId),
      loadUserTimezone(authenticatedUserId),
    ]);
    const customCategoriesList =
      customCategories.length > 0
        ? customCategories
            .map(
              (cat: {
                name: string;
                measurement_type: string;
                frequency: string;
              }) => `- ${cat.name} (${cat.measurement_type}, ${cat.frequency})`
            )
            .join('\n')
        : 'None';

    const systemPromptContent = `You are Sparky, an AI nutrition/wellness Telegram coach.
Goal: Track food, exercise, measurements, and provide brief, actionable advice.
Date: ${todayInZone(chatTz)}.

**CORE RULES:**
1. **Brevity & Style:** Keep responses concise, friendly, and coaching-oriented. Use Telegram HTML formatting (<b>, <i>, <code>) and emojis in the 'response' field.
2. **Context:** Use [SYSTEM CONTEXT: RECENT PROGRESS] for insights. Don't ask for data already provided.
3. **Dates:** Extract explicitly mentioned dates/times to the root 'entryDate' field ("today", "yesterday", "MM-DD", "YYYY-MM-DD"). Do NOT resolve relative dates to full dates. Omit if none.
4. **Water is NOT Food:** NEVER log water under 'log_food'. ALWAYS use 'log_water'.
5. **Images & Unknown Foods:**
   - Extract food/exercise, estimate quantity, unit, and meal_type.
   - **CRITICAL:** Always infer detailed nutrition based on the photo or your general knowledge if not in DB.
   - **MAXIMAL DETAIL:** For 'log_food', you MUST provide 'calories', 'protein', 'carbs', 'fat' AND any inferable micros like 'sugars', 'dietary_fiber', 'sodium', 'potassium', 'cholesterol', 'saturated_fat', 'vitamin_a', 'vitamin_c', 'calcium', 'iron'.
   - **MISSING DATA:** If a photo/text lacks clear portion size, output 'ask_question' intent to clarify. Do NOT guess completely ambiguous sizes.
6. **Units & Custom Names:**
   - Convert counts ("2 apples") to unit "piece". Match user units ("g", "cup"). Infer if missing.
   - For custom measurements, strictly match names from this list: ${customCategoriesList}.
7. **History Requests:** If the user asks for historical data AND the data is NOT already provided in the SYSTEM UPDATE context, you MUST return the 'request_data' intent. Set 'response' to a brief waiting message. If the data IS provided, use 'chat' intent to summarize it.

**PROACTIVE COACHING (CRITICAL):**
1. **Evaluation:** After logging food or exercise, ALWAYS evaluate the current daily totals against the [USER NUTRITION PLAN] provided in the context.
2. **Enforce Rules:** If a user logs a food that violates their specific rules (e.g., sweet oatmeal for breakfast, or drinking beer on a non-hiking day), gently point it out in the 'response' and explain WHY based on the plan rules.
3. **Praise:** Praise them heavily for logging high-fiber foods (vegetables) or hitting protein targets.
4. **Suggest:** Look at remaining macros. If protein is low at the end of the day, suggest specific foods from their plan (e.g., cottage cheese or fish).

**OUTPUT FORMAT:**
You MUST reply with a STRICT JSON object matching this schema:

{
  "intent": "log_food" | "log_exercise" | "log_measurement" | "log_water" | "delete_measurement" | "delete_food" | "ask_question" | "chat" | "request_data",
  "data": { ... }, // Specific to intent, see below
  "entryDate": "string", // Optional
  "response": "string" // Optional for logs, REQUIRED for chat/questions/request_data. Use HTML/emojis.
}

**INTENTS & DATA SCHEMAS:**
- 'log_food': { food_name: string, quantity: number, unit: string, meal_type: string, calories: number, protein: number, carbs: number, fat: number, dietary_fiber: number, sugars: number, ...[include any inferable micros], serving_size: number, serving_unit: string }
- 'log_exercise': { exercise_name: string, duration_minutes: number|null, distance: number|null, distance_unit: string|null, calories_burned: number|null }
- 'log_measurement': { measurements: [{ type: "weight"|"neck"|"waist"|"hips"|"steps"|"custom", value: number, unit: string|null, name: string|null }] }
- 'log_water': { glasses_consumed: number }
- 'delete_measurement': { measurements: [{ type: string, value: number|null }] }
- 'delete_food': { food_name: string|null }
- 'request_data': { type: "food_history" | "exercise_history" | "measurements_history", days: "14" }
- 'ask_question' / 'chat': {}

**SPECIAL COMMAND:**
If input is "GENERATE_FOOD_OPTIONS:[food name] in [unit]", return ONLY a JSON array of 2-3 realistic options.
Schema: [{"name": "string", "calories": number, "protein": number, "carbs": number, "fat": number, "serving_size": number, "serving_unit": "string"}]`;

    const messagesForAI: ChatMessage[] = [];
    const customSystemMessage = messages.find((msg) => msg.role === 'system');

    if (customSystemMessage) {
      messagesForAI.push({
        role: 'system',
        content: customSystemMessage.content,
      });
    } else {
      messagesForAI.push({ role: 'system', content: systemPromptContent });
    }

    messagesForAI.push(...messages.filter((msg) => msg.role !== 'system'));

    const cleanSystemPrompt = systemPromptContent
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 15000);

    switch (aiService.service_type) {
      case 'openai':
      case 'openai_compatible':
      case 'mistral':
      case 'groq':
      case 'openrouter':
      case 'custom': {
        log(
          'debug',
          `[AI Service Request] Type: ${aiService.service_type}, URL: ${
            aiService.service_type === 'openai'
              ? 'https://api.openai.com/v1/chat/completions'
              : aiService.service_type === 'openai_compatible'
                ? `${aiService.custom_url}/chat/completions`
                : aiService.service_type === 'mistral'
                  ? 'https://api.mistral.ai/v1/chat/completions'
                  : aiService.service_type === 'groq'
                    ? 'https://api.groq.com/openai/v1/chat/completions'
                    : aiService.service_type === 'openrouter'
                      ? 'https://openrouter.ai/api/v1/chat/completions'
                      : aiService.custom_url
          }, Model: ${model}, API Key Provided: ${!!aiService.api_key}`
        );
        const aiTimeoutMs = 60_000;
        const aiAbortController = new AbortController();
        const aiTimeoutId = setTimeout(
          () => aiAbortController.abort(),
          aiTimeoutMs
        );
        try {
          response = await fetch(
            aiService.service_type === 'openai'
              ? 'https://api.openai.com/v1/chat/completions'
              : aiService.service_type === 'openai_compatible'
                ? `${aiService.custom_url}/chat/completions`
                : aiService.service_type === 'mistral'
                  ? 'https://api.mistral.ai/v1/chat/completions'
                  : aiService.service_type === 'groq'
                    ? 'https://api.groq.com/openai/v1/chat/completions'
                    : aiService.service_type === 'openrouter'
                      ? 'https://openrouter.ai/api/v1/chat/completions'
                      : aiService.custom_url || '',
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(aiService.service_type === 'openrouter' && {
                  'HTTP-Referer': 'https://sparky-fitness.com',
                  'X-Title': 'Sparky Fitness',
                }),
                ...(aiService.api_key && {
                  Authorization: `Bearer ${aiService.api_key}`,
                }),
              },
              body: JSON.stringify({
                model: model,
                messages: messagesForAI,
                temperature: 0.7,
              }),
              signal: aiAbortController.signal,
            }
          );
        } finally {
          clearTimeout(aiTimeoutId);
        }

        if (!response) {
          throw new Error('Fetch did not return a response object.');
        }
        break;
      }

      case 'anthropic':
        log(
          'debug',
          `[AI Service Request] Type: Anthropic, URL: https://api.anthropic.com/v1/messages, Model: ${model}, API Key Provided: ${!!aiService.api_key}`
        );
        response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            ...(aiService.api_key && { 'x-api-key': aiService.api_key }),
          },
          body: JSON.stringify({
            model: model,
            max_tokens: 1000,
            messages: messagesForAI
              .filter((msg) => msg.role !== 'system')
              .map((msg) => ({
                role: msg.role === 'assistant' ? 'assistant' : 'user',
                content: msg.content,
              })),
            system: systemPromptContent,
          }),
        });

        if (!response) {
          throw new Error('Fetch did not return a response object.');
        }
        break;

      case 'google': {
        const googleBody = {
          contents: messagesForAI
            .map((msg) => {
              const role = msg.role === 'assistant' ? 'model' : 'user';
              let parts: any[] = [];
              if (typeof msg.content === 'string') {
                parts.push({ text: msg.content });
              } else if (Array.isArray(msg.content)) {
                parts = msg.content
                  .map((part) => {
                    if (part.type === 'text') {
                      return { text: part.text };
                    } else if (
                      part.type === 'image_url' &&
                      part.image_url?.url
                    ) {
                      try {
                        const urlParts = part.image_url.url.split(';base64,');
                        if (urlParts.length !== 2) {
                          log(
                            'error',
                            'Invalid data URL format for image part. Expected "data:[mimeType];base64,[data]".'
                          );
                          return null;
                        }
                        const mimeTypeMatch =
                          urlParts[0].match(/^data:(.*?)(;|$)/);
                        let mimeType = '';
                        if (mimeTypeMatch && mimeTypeMatch[1]) {
                          mimeType = mimeTypeMatch[1];
                        } else {
                          log(
                            'error',
                            'Could not extract mime type from data URL prefix:',
                            urlParts[0]
                          );
                          return null;
                        }
                        const base64Data = urlParts[1];
                        return {
                          inline_data: {
                            mime_type: mimeType,
                            data: base64Data,
                          },
                        };
                      } catch (e) {
                        log('error', 'Error processing image data URL:', e);
                        return null;
                      }
                    }
                    return null;
                  })
                  .filter((part) => part !== null);
              }
              if (
                parts.length === 0 &&
                Array.isArray(msg.content) &&
                msg.content.some((part) => part.type === 'image_url')
              ) {
                parts.push({ text: '' });
              }
              return {
                parts: parts,
                role: role,
              };
            })
            .filter((content) => content.parts.length > 0),
          systemInstruction: undefined as any,
        };

        if (googleBody.contents.length === 0) {
          throw new Error(
            'No valid content (text or image) found to send to Google AI.'
          );
        }

        if (cleanSystemPrompt && cleanSystemPrompt.length > 0) {
          (googleBody as any).systemInstruction = {
            parts: [{ text: cleanSystemPrompt }],
          };
        }

        if (!aiService.api_key) {
          throw new Error('API key missing for Google AI service.');
        }
        log(
          'debug',
          `[AI Service Request] Type: Google, URL: https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=..., Model: ${model}, API Key Provided: ${!!aiService.api_key}`
        );
        response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${aiService.api_key}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(googleBody),
          }
        );

        if (!response) {
          throw new Error('Fetch did not return a response object.');
        }
        break;
      }

      case 'ollama': {
        const ollamaMessages = messagesForAI.map((msg) => {
          let contentString = '';
          if (Array.isArray(msg.content)) {
            const textParts = msg.content.filter(
              (part) => part.type === 'text'
            );
            if (textParts.length > 0) {
              contentString = textParts.map((part) => part.text).join(' ');
            }
            const imageParts = msg.content.filter(
              (part) => part.type === 'image_url'
            );
            if (imageParts.length > 0) {
              log(
                'warn',
                'Image data detected for Ollama service. Ollama does not support multimodal input in this format. Image data will be ignored.'
              );
            }
          } else if (typeof msg.content === 'string') {
            contentString = msg.content;
          }
          return { role: msg.role, content: contentString };
        });

        const timeout = (aiService as any).timeout || 1200000;
        log('info', `Ollama chat request timeout set to ${timeout}ms`);

        const ollamaAgent = new Agent({
          headersTimeout: timeout,
          bodyTimeout: timeout,
        });

        try {
          log(
            'debug',
            `[AI Service Request] Type: Ollama, URL: ${aiService.custom_url}/api/chat, Model: ${model}, API Key Provided: ${!!aiService.api_key}`
          );
          response = await fetch(`${aiService.custom_url}/api/chat`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: model,
              messages: ollamaMessages,
              stream: false,
            }),
            dispatcher: ollamaAgent,
          } as any);
        } catch (error: any) {
          if (
            error.name === 'HeadersTimeoutError' ||
            error.name === 'BodyTimeoutError'
          ) {
            throw new Error(
              `Ollama chat request timed out after ${timeout}ms due to undici timeout.`,
              { cause: error }
            );
          }
          throw new Error(
            `AI service API call error: 502 - Ollama fetch error: ${error.message}`,
            { cause: error }
          );
        } finally {
          ollamaAgent.destroy();
        }
        break;
      }

      default: {
        const hasImage = messagesForAI.some(
          (msg) =>
            Array.isArray(msg.content) &&
            msg.content.some((part) => part.type === 'image_url')
        );
        if (hasImage) {
          throw new Error(
            `Image analysis is not supported for the selected AI service type: ${aiService.service_type}. Please select a multimodal model like Google Gemini in settings.`
          );
        }
        throw new Error(`Unsupported service type: ${aiService.service_type}`);
      }
    }

    if (!response.ok) {
      const errorBody = await response.text();
      log(
        'error',
        `AI service API call error for ${aiService.service_type}. Status: ${response.status}, StatusText: ${response.statusText}, Body: ${errorBody}`
      );
      throw new Error(
        `AI service API call error: ${response.status} - ${response.statusText}`
      );
    }

    const data = await response.json();
    let usage = extractAiUsageStats(aiService.service_type, data);
    let content = '';

    if (usage) {
      log(
        'info',
        `[AI USAGE] ${aiService.service_type}: input=${usage.inputTokens}, output=${usage.outputTokens}, total=${usage.totalTokens}`
      );
    }

    switch (aiService.service_type) {
      case 'openai':
      case 'openai_compatible':
      case 'mistral':
      case 'groq':
      case 'openrouter':
      case 'custom':
        content =
          data.choices?.[0]?.message?.content || 'No response from AI service';
        break;
      case 'anthropic':
        content = data.content?.[0]?.text || 'No response from AI service';
        break;
      case 'google':
        content =
          data.candidates?.[0]?.content?.parts?.[0]?.text ||
          'No response from AI service';
        break;
      case 'ollama':
        content = data.message?.content || 'No response from AI service';
        break;
    }

    if (!usage) {
      usage = estimateAiUsageStats(messagesForAI, content);
      log(
        'info',
        `[AI USAGE] ${aiService.service_type}: input=${usage.inputTokens}, output=${usage.outputTokens}, total=${usage.totalTokens} (estimated)`
      );
    }

    log('info', `[AI RAW RESPONSE] ${content}`);

    let responseText = content;
    let intent = null;
    let intentData = null;
    let entryDate = null;

    try {
      const firstBrace = content.indexOf('{');
      const lastBrace = content.lastIndexOf('}');

      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const potentialJson = content.substring(firstBrace, lastBrace + 1);
        const parsed = JSON.parse(potentialJson);

        responseText = parsed.response || parsed.responseText || content;
        intent = parsed.intent || null;
        intentData = parsed.data || null;
        entryDate = parsed.entryDate || parsed.entry_date || null;

        if (intent && !intentData) {
          const {
            intent: _i,
            response: _r,
            responseText: _rt,
            entryDate: _ed,
            entry_date: _ed2,
            ...dataAtRoot
          } = parsed;
          if (Object.keys(dataAtRoot).length > 0) {
            intentData = dataAtRoot;
            log(
              'info',
              "[AI RESPONSE] Extracted intentData from root because 'data' key was missing"
            );
          }
        }
      }
    } catch {
      log('info', 'AI response JSON parsing failed, treating as plain text.');
    }

    return {
      content: responseText,
      text: responseText,
      intent,
      data: intentData,
      entryDate,
      usage,
    };
  } catch (error: unknown) {
    log(
      'error',
      `Error processing chat message for user ${authenticatedUserId}:`,
      error
    );
    throw error;
  }
}

export async function processFoodOptionsRequest(
  foodName: string,
  unit: string,
  authenticatedUserId: string,
  serviceConfigId: string
) {
  try {
    if (!serviceConfigId) {
      throw new Error('AI service configuration ID is missing.');
    }

    const aiService = await chatRepository.getAiServiceSettingForBackend(
      serviceConfigId,
      authenticatedUserId
    );
    if (!aiService) {
      throw new Error('AI service setting not found for the provided ID.');
    }

    const source = aiService.source || 'unknown';
    log(
      'info',
      `Processing food options request for user ${authenticatedUserId} using AI service from ${source} (ID: ${serviceConfigId})`
    );

    if (aiService.service_type !== 'ollama' && !aiService.api_key) {
      throw new Error('API key missing for selected AI service.');
    }

    const systemPrompt = `You are Sparky, an AI nutrition and wellness coach. Your task is to generate minimum 3 realistic food options in JSON format when requested. Respond ONLY with a JSON array of FoodOption objects, including detailed nutritional information (calories, protein, carbs, fat, saturated_fat, polyunsaturated_fat, monounsaturated_fat, trans_fat, cholesterol, sodium, potassium, dietary_fiber, sugars, vitamin_a, vitamin_c, calcium, iron). **CRITICAL: Always provide estimated nutritional details for each food option. Do NOT default to 0 for any nutritional field if an estimation can be made.** Do NOT include any other text.
**CRITICAL: When a unit is specified in the request (e.g., 'GENERATE_FOOD_OPTIONS:apple in piece'), ensure the \`serving_unit\` in the generated \`FoodOption\` objects matches the requested unit exactly, if it's a common and logical unit for that food. If not, provide a common and realistic serving unit.**`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `GENERATE_FOOD_OPTIONS:${foodName} in ${unit}` },
    ];

    const model =
      aiService.model_name || getDefaultModel(aiService.service_type);

    let response;
    switch (aiService.service_type) {
      case 'openai':
      case 'openai_compatible':
      case 'mistral':
      case 'groq':
      case 'openrouter':
      case 'custom': {
        log(
          'debug',
          `[AI Service Request] Type: ${aiService.service_type} (Food Options), URL: ${
            aiService.service_type === 'openai'
              ? 'https://api.openai.com/v1/chat/completions'
              : aiService.custom_url
          }, Model: ${model}`
        );
        response = await fetch(
          aiService.service_type === 'openai'
            ? 'https://api.openai.com/v1/chat/completions'
            : aiService.service_type === 'openai_compatible'
              ? `${aiService.custom_url}/chat/completions`
              : aiService.service_type === 'mistral'
                ? 'https://api.mistral.ai/v1/chat/completions'
                : aiService.service_type === 'groq'
                  ? 'https://api.groq.com/openai/v1/chat/completions'
                  : aiService.service_type === 'openrouter'
                    ? 'https://openrouter.ai/api/v1/chat/completions'
                    : aiService.custom_url || '',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(aiService.api_key && {
                Authorization: `Bearer ${aiService.api_key}`,
              }),
            },
            body: JSON.stringify({ model, messages, temperature: 0.7 }),
          }
        );
        break;
      }

      case 'anthropic':
        response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            ...(aiService.api_key && { 'x-api-key': aiService.api_key }),
          },
          body: JSON.stringify({
            model,
            max_tokens: 1000,
            messages: messages.filter((msg) => msg.role !== 'system'),
            system: systemPrompt,
          }),
        });
        break;

      case 'google': {
        const googleBodyFoodOptions = {
          contents: messages
            .map((msg) => ({
              parts: [{ text: msg.content }],
              role: msg.role === 'assistant' ? 'model' : 'user',
            }))
            .filter((content) => content.parts[0].text.trim() !== ''),
          systemInstruction: { parts: [{ text: systemPrompt }] },
        };
        response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${aiService.api_key}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(googleBodyFoodOptions),
          }
        );
        break;
      }

      case 'ollama': {
        const ollamaAgentFoodOptions = new Agent({
          headersTimeout: 1200000,
          bodyTimeout: 1200000,
        });
        try {
          response = await fetch(`${aiService.custom_url}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              messages: messages.map((msg) => ({
                role: msg.role,
                content: msg.content,
              })),
              stream: false,
            }),
            dispatcher: ollamaAgentFoodOptions,
          } as any);
        } finally {
          ollamaAgentFoodOptions.destroy();
        }
        break;
      }

      default:
        throw new Error(
          `Unsupported service type for food options generation: ${aiService.service_type}`
        );
    }

    if (!response.ok)
      throw new Error(`AI service API call error: ${response.status}`);

    const data = await response.json();
    let usage = extractAiUsageStats(aiService.service_type, data);
    let content = '';

    if (usage) {
      log(
        'info',
        `[AI USAGE] ${aiService.service_type}: input=${usage.inputTokens}, output=${usage.outputTokens}, total=${usage.totalTokens}`
      );
    }
    switch (aiService.service_type) {
      case 'openai':
      case 'openai_compatible':
      case 'mistral':
      case 'groq':
      case 'openrouter':
      case 'custom':
        content = data.choices?.[0]?.message?.content || '';
        break;
      case 'anthropic':
        content = data.content?.[0]?.text || '';
        break;
      case 'google':
        content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        break;
      case 'ollama':
        content = data.message?.content || '';
        break;
    }

    if (!usage) {
      usage = estimateAiUsageStats(messages, content);
      log(
        'info',
        `[AI USAGE] ${aiService.service_type}: input=${usage.inputTokens}, output=${usage.outputTokens}, total=${usage.totalTokens} (estimated)`
      );
    }

    return { content };
  } catch (error: unknown) {
    log(
      'error',
      `Error processing food options request for user ${authenticatedUserId}:`,
      error
    );
    throw error;
  }
}

export default {
  handleAiServiceSettings,
  getAiServiceSettings,
  getActiveAiServiceSetting,
  deleteAiServiceSetting,
  clearOldChatHistory,
  getSparkyChatHistory,
  getSparkyChatHistoryEntry,
  updateSparkyChatHistoryEntry,
  deleteSparkyChatHistoryEntry,
  clearAllSparkyChatHistory,
  saveSparkyChatHistory,
  processChatMessage,
  processFoodOptionsRequest,
};
