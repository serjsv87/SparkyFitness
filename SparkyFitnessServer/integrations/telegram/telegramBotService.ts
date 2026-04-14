import TelegramBot from 'node-telegram-bot-api';
import { log } from '../../config/logging.js';
import globalSettingsRepository from '../../models/globalSettingsRepository.js';
import chatService, { ChatMessage } from '../../services/chatService.js';
import * as chatRepository from '../../models/chatRepository.js';
import * as exerciseEntry from '../../models/exerciseEntry.js';
import * as foodEntryRepository from '../../models/foodEntry.js';
import * as poolManager from '../../db/poolManager.js';
import { executeIntent } from './intentExecutor.js';
import { TelegramAiService } from './telegramAiService.js';
import axios from 'axios';
import {
  TranslationSet,
  TelegramUser,
  getTranslations,
  getMainMenuKeyboard,
} from './telegramTranslations.js';
import { loadUserTimezone } from '../../utils/timezoneLoader.js';
import { todayInZone, addDays, instantToDay } from '@workspace/shared';

/**
 * Service to manage Telegram Bot interactions.
 * Connects Telegram users to SparkyFitness AI and database.
 */
class TelegramBotService {
  private bot: TelegramBot | null = null;
  private botToken: string | null = null;
  private activeGarminSyncs: Set<number> = new Set();

  constructor() {
    this.bot = null;
  }

  async initialize(): Promise<void> {
    try {
      const settings = await globalSettingsRepository.getGlobalSettings();
      this.botToken =
        settings.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN;

      if (!this.botToken) {
        log(
          'info',
          '[TELEGRAM BOT] Bot token not configured. Telegram integration is inactive.'
        );
        return;
      }

      const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;

      if (webhookUrl) {
        log(
          'info',
          `[TELEGRAM BOT] Initializing in WEBHOOK mode. URL: ${webhookUrl}`
        );
        this.bot = new TelegramBot(this.botToken!, { polling: false });
        const fullWebhookUrl = `${webhookUrl.replace(/\/$/, '')}/api/telegram/webhook`;
        await this.bot.setWebHook(fullWebhookUrl);
        log('info', `[TELEGRAM BOT] Webhook registered: ${fullWebhookUrl}`);
      } else {
        log('info', '[TELEGRAM BOT] Initializing in POLLING mode.');
        this.bot = new TelegramBot(this.botToken!, { polling: true });
      }

      log(
        'info',
        `[TELEGRAM BOT] Bot active: ${settings.telegram_bot_name || 'SparkyFitnessBot'}`
      );
      this.setupHandlers();
    } catch (error: unknown) {
      log('error', '[TELEGRAM BOT] Initialization error:', error);
    }
  }

  handleUpdate(update: TelegramBot.Update): void {
    if (this.bot) {
      this.bot.processUpdate(update);
    }
  }

  private setupHandlers(): void {
    if (!this.bot) return;

    this.bot.onText(/\/start( (.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const linkParam = match ? match[2] : null;

      if (linkParam) {
        return this.handleLink(chatId, linkParam.trim());
      }

      const user = await this.findUserAndLanguageByChatId(chatId);

      if (user) {
        const lang = user.language;
        const t = getTranslations(lang);
        const keyboardOptions = getMainMenuKeyboard(t);

        return this.bot!.sendMessage(
          chatId,
          `${t.greeting}, ${user.name}! ${t.helpPrompt}`,
          keyboardOptions
        );
      }

      this.bot!.sendMessage(
        chatId,
        'Welcome to SparkyFitness! Link your account in the web app under Settings → Telegram, then send `/start <CODE>`.'
      );
    });

    this.bot.onText(/\/(profile|профиль)/i, async (msg) => {
      const chatId = msg.chat.id;
      const user = await this.findUserAndLanguageByChatId(chatId);
      if (!user) return;

      this.bot!.sendChatAction(chatId, 'typing').catch(() => {});
      try {
        const profileText = await this.formatProfileResponse(
          user.id,
          user.language
        );
        this.bot!.sendMessage(chatId, profileText, { parse_mode: 'HTML' });
      } catch (error: unknown) {
        this.bot!.sendMessage(
          chatId,
          `❌ Error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });

    this.bot.onText(/\/(diary|дневник|щоденник)/i, async (msg) => {
      const chatId = msg.chat.id;
      const user = await this.findUserAndLanguageByChatId(chatId);
      if (!user) return;

      const t = getTranslations(user.language);
      return this.bot!.sendMessage(
        chatId,
        t.diary,
        this.getDiaryMenuKeyboard(t)
      );
    });

    this.bot.onText(/\/(exercises|упражнения|вправи)/i, async (msg) => {
      const chatId = msg.chat.id;
      const user = await this.findUserAndLanguageByChatId(chatId);
      if (!user) return;

      this.bot!.sendChatAction(chatId, 'typing').catch(() => {});
      return this.handleDirectRecentExercises(chatId, user);
    });

    this.bot.onText(
      /\/(sync|синхронизировать|синхронізувати)/i,
      async (msg) => {
        const chatId = msg.chat.id;
        const user = await this.findUserAndLanguageByChatId(chatId);
        if (!user) return;
        return this.showSyncMenu(chatId, user.language);
      }
    );

    this.bot.on('message', async (msg) => {
      if (msg.text && msg.text.startsWith('/')) return;

      const chatId = msg.chat.id;
      const user = await this.findUserAndLanguageByChatId(chatId);

      if (!user) {
        this.bot!.sendMessage(
          chatId,
          'Your account is not linked. Please link it in the web app under Settings → Telegram, then send `/start <CODE>`.'
        );
        return;
      }

      const t = getTranslations(user.language);

      // Centralized button handling
      if (msg.text === t.profile) {
        this.bot!.sendChatAction(chatId, 'typing').catch(() => {});
        const profileText = await this.formatProfileResponse(
          user.id,
          user.language
        );
        this.bot!.sendMessage(chatId, profileText, { parse_mode: 'HTML' });
        return;
      }

      if (msg.text === t.diary) {
        this.bot!.sendMessage(chatId, t.diary, this.getDiaryMenuKeyboard(t));
        return;
      }

      if (msg.text === t.exercises) {
        this.bot!.sendChatAction(chatId, 'typing').catch(() => {});
        return this.handleDirectRecentExercises(chatId, user);
      }

      if (msg.text === t.syncMenu) {
        return this.showSyncMenu(chatId, user.language);
      }

      if (msg.text === t.language) {
        return this.showLanguageMenu(chatId);
      }

      if (msg.text === t.back) {
        return this.bot!.sendMessage(chatId, t.welcome, getMainMenuKeyboard(t));
      }

      // Handle custom standard commands directly without AI
      if (msg.text === t.todayLog) {
        await this.handleDirectTodayLog(chatId, user);
        return;
      }

      if (msg.text === t.macros) {
        this.bot!.sendChatAction(chatId, 'typing').catch(() => {});
        try {
          const profileText = await this.formatProfileResponse(
            user.id,
            user.language
          );
          this.bot!.sendMessage(chatId, profileText, { parse_mode: 'HTML' });
        } catch (error: unknown) {
          this.bot!.sendMessage(
            chatId,
            `❌ Error: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        return;
      }

      if (msg.text === t.addWater) {
        this.bot!.sendChatAction(chatId, 'typing').catch(() => {});
        const today = todayInZone(user.timezone || 'UTC');
        const intentResult = await executeIntent(
          'log_water',
          { quantity: 1, unit: 'glass' },
          null,
          user.id,
          today
        );
        this.bot!.sendMessage(chatId, intentResult as string, {
          parse_mode: 'HTML',
        });
        return;
      }

      await this.processMessage(chatId, user, msg);
    });

    this.bot.on('callback_query', async (query) => {
      const chatId = query.message?.chat.id;
      if (!chatId) return;

      const user = await this.findUserAndLanguageByChatId(chatId);
      if (!user) return;

      const [action, type] = (query.data || '').split(':');

      if (action === 'setlang') {
        const newLang = type;
        await this.setLanguage(user.id, newLang);
        const t = getTranslations(newLang);

        await this.bot!.deleteMessage(chatId, query.message!.message_id).catch(
          () => false
        );
        await this.bot!.sendMessage(chatId, t.langSet, getMainMenuKeyboard(t));
        return this.bot!.answerCallbackQuery(query.id).catch(() => {});
      } else if (action === 'sync') {
        const garminService = await import('../../services/garminService.js');

        if (type === 'garmin') {
          if (this.activeGarminSyncs.has(chatId)) {
            return this.bot!.sendMessage(
              chatId,
              '⚠️ Синхронізація з Garmin вже триває. Будь ласка, зачекайте.'
            ).catch(() => {});
          }

          this.activeGarminSyncs.add(chatId);

          const statusMsg = (await this.bot!.sendMessage(
            chatId,
            '🔄 Починаємо синхронізацію з Garmin (за 7 днів)...',
            { disable_notification: true }
          )) as TelegramBot.Message;

          try {
            const tz = (user as { timezone?: string }).timezone || 'UTC';
            const today = todayInZone(tz);
            let successCount = 0;
            const totalDays = 7;

            for (let i = 0; i < totalDays; i++) {
              const currentDate = addDays(today, -i);
              const dayNum = i + 1;

              const filledBlocks = '▓'.repeat(dayNum);
              const emptyBlocks = '░'.repeat(totalDays - dayNum);
              const progressBar = `[${filledBlocks}${emptyBlocks}]`;

              await this.bot!.editMessageText(
                `⏳ Синхронізація Garmin...\n${progressBar} ${dayNum}/${totalDays}\n📅 Дата: ${currentDate}`,
                {
                  chat_id: chatId,
                  message_id: statusMsg.message_id,
                  disable_web_page_preview: true,
                }
              ).catch(() => {});

              // Garmin sync service - sync specific day
              await garminService.syncGarminData(
                user.id,
                'manual',
                currentDate,
                currentDate
              );
              successCount++;

              // Small delay for smooth UI feedback
              await new Promise((resolve) => setTimeout(resolve, 300));
            }

            await this.bot!.editMessageText(
              `✅ Синхронізація з Garmin завершена за ${successCount} днів!\n📊 Активності, показники та вода оновлені.`,
              {
                chat_id: chatId,
                message_id: statusMsg.message_id,
              }
            ).catch(() => {});
          } catch (error: unknown) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            log('error', `[TELEGRAM BOT] Garmin sync error: ${errorMessage}`);
            await this.bot!.sendMessage(
              chatId,
              `❌ Помилка синхронізації Garmin: ${errorMessage}. Переконайтеся, що ваш акаунт підключено у веб-додатку.`,
              { disable_notification: true }
            ).catch(() => {});
          } finally {
            this.activeGarminSyncs.delete(chatId);
          }
          return this.bot!.answerCallbackQuery(query.id).catch(() => {});
        } else if (type === 'mfp') {
          const t = getTranslations(user.language);
          if (this.activeGarminSyncs.has(chatId)) {
            return this.bot!.sendMessage(
              chatId,
              '⚠️ Синхронізація вже триває.'
            ).catch(() => {});
          }

          this.activeGarminSyncs.add(chatId); // Reusing the sync lock
          const statusMsg = (await this.bot!.sendMessage(
            chatId,
            `${t.syncMFPInProgress} (за 7 днів)...`,
            { disable_notification: true }
          )) as TelegramBot.Message;

          try {
            const mfpSyncService =
              await import('../../services/mfpSyncService.js');
            const tz = (user as { timezone?: string }).timezone || 'UTC';
            const today = todayInZone(tz);
            const totalDays = 7;
            let successCount = 0;

            for (let i = 0; i < totalDays; i++) {
              const currentDate = addDays(today, -i);
              const dayNum = i + 1;

              const filledBlocks = '▓'.repeat(dayNum);
              const emptyBlocks = '░'.repeat(totalDays - dayNum);
              const progressBar = `[${filledBlocks}${emptyBlocks}]`;

              await this.bot!.editMessageText(
                `⏳ Синхронізація MyFitnessPal...\n${progressBar} ${dayNum}/${totalDays}\n📅 Дата: ${currentDate}`,
                {
                  chat_id: chatId,
                  message_id: statusMsg.message_id,
                }
              ).catch(() => {});

              // The function is named syncDailyNutritionToMFP in mfpSyncService.ts
              // We call it for each day. It handles both food and water.
              await mfpSyncService.syncDailyNutritionToMFP(
                user.id,
                currentDate
              );
              successCount++;

              await new Promise((resolve) => setTimeout(resolve, 300));
            }

            await this.bot!.editMessageText(
              `✅ ${t.syncMFPSuccess} за ${successCount} днів!`,
              {
                chat_id: chatId,
                message_id: statusMsg.message_id,
              }
            ).catch(() => {});
          } catch (error: unknown) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            log('error', `[TELEGRAM BOT] MFP sync error: ${errorMessage}`);
            await this.bot!.editMessageText(
              `❌ ${t.syncMFPError.replace('{{error}}', errorMessage)}`,
              {
                chat_id: chatId,
                message_id: statusMsg.message_id,
              }
            ).catch(() => {});
          } finally {
            this.activeGarminSyncs.delete(chatId);
          }
          return this.bot!.answerCallbackQuery(query.id).catch(() => {});
        }
      } else if (action === 'del_f') {
        const foodEntryId = type;
        const t = getTranslations(user.language);
        try {
          await foodEntryRepository.deleteFoodEntry(foodEntryId, user.id);
          await this.bot!.answerCallbackQuery(query.id, {
            text: t.deletedSuccess,
          }).catch(() => {});
          // Optional: update the message to remove the deleted item or just delete the message
          await this.bot!.deleteMessage(
            chatId,
            query.message!.message_id
          ).catch(() => false);
          await this.handleDirectTodayLog(chatId, user);
        } catch (e: unknown) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          log('error', `[TELEGRAM BOT] Delete food error: ${errorMessage}`);
          await this.bot!.answerCallbackQuery(query.id, {
            text: t.deleteError,
            show_alert: true,
          }).catch(() => {});
        }
      } else if (action === 'del_m') {
        const [id, mType] = type.split(',');
        const t = getTranslations(user.language);
        try {
          // Check if it's a check-in measurement or custom
          const measurementService =
            await import('../../services/measurementService.js');
          if (
            mType === 'weight' ||
            mType === 'neck' ||
            mType === 'waist' ||
            mType === 'hips' ||
            mType === 'steps' ||
            mType === 'height'
          ) {
            await measurementService.deleteCheckIn(user.id, id);
          } else {
            await measurementService.deleteCustomMeasurement(user.id, id);
          }
          await this.bot!.answerCallbackQuery(query.id, {
            text: t.deletedSuccess,
          }).catch(() => {});
          await this.bot!.deleteMessage(
            chatId,
            query.message!.message_id
          ).catch(() => false);
        } catch (e: unknown) {
          log(
            'error',
            `[TELEGRAM BOT] Delete measurement error: ${(e as Error).message}`
          );
          await this.bot!.answerCallbackQuery(query.id, {
            text: t.deleteError,
            show_alert: true,
          }).catch(() => {});
        }
      } else if (action === 'cancel_del') {
        await this.bot!.deleteMessage(chatId, query.message!.message_id).catch(
          () => false
        );
        return this.bot!.answerCallbackQuery(query.id).catch(() => {});
      }
    });

    log('info', '[TELEGRAM BOT] Handlers setup complete.');
  }

  async handleLink(chatId: number, code: string): Promise<void> {
    const client = await poolManager.getSystemClient();
    try {
      const result = await client.query(
        `SELECT u.id, u.name, p.language 
         FROM public."user" u
         LEFT JOIN user_preferences p ON u.id = p.user_id
         WHERE u.telegram_link_code = $1`,
        [code]
      );

      if (result.rows.length === 0) {
        await this.bot!.sendMessage(
          chatId,
          '❌ Invalid linking code. Please check the web app for a fresh code.'
        );
        return;
      }

      const user = result.rows[0];
      await client.query(
        'UPDATE public."user" SET telegram_chat_id = $1, telegram_link_code = NULL WHERE id = $2',
        [chatId.toString(), user.id]
      );

      const t = getTranslations(user.language);
      await this.bot!.sendMessage(
        chatId,
        `✅ Success! Your account is now linked, ${user.name}. ${t.helpPrompt}`,
        this.getMainMenuKeyboard(t)
      );
    } catch (e: unknown) {
      log('error', '[TELEGRAM BOT] Linking error:', e);
      await this.bot!.sendMessage(
        chatId,
        `❌ Link error: ${(e as Error).message}`
      );
    } finally {
      client.release();
    }
  }

  private classifyContextMode(
    msg: TelegramBot.Message
  ): 'chat' | 'food' | 'exercise' | 'analysis' {
    const text = `${msg.text || ''} ${msg.caption || ''}`.toLowerCase();
    const hasImage = Array.isArray(msg.photo) && msg.photo.length > 0;
    const hasExerciseMedia = Boolean(
      msg.voice || msg.audio || msg.video || msg.video_note || msg.document
    );

    const analysisKeywords = [
      'analyze',
      'analysis',
      'recommend',
      'recommendation',
      'should i',
      'deficit',
      'surplus',
      'plan',
      'why',
      'compare',
      'порекоменду',
      'проаналіз',
      'аналіз',
      'рекоменд',
      'чому',
      'порівняй',
    ];

    const foodKeywords = [
      'food',
      'meal',
      'eat',
      'ate',
      'breakfast',
      'lunch',
      'dinner',
      'snack',
      'calorie',
      'protein',
      'carb',
      'fat',
      'що я поїв',
      'що я їв',
      'запиши',
      'каву',
      'снідан',
      'обід',
      'вечер',
      'перекус',
      'вода',
      'water',
      'drink',
    ];

    const exerciseKeywords = [
      'workout',
      'exercise',
      'training',
      'run',
      'bike',
      'cycle',
      'swim',
      'walk',
      'hike',
      'session',
      'burn',
      'burned',
      'active calories',
      'спал',
      'спалив',
      'тренир',
      'тренув',
      'вправ',
      'кардио',
      'біг',
      'йога',
      'зал',
    ];

    const hasFoodIntent =
      foodKeywords.some((keyword) => text.includes(keyword)) || hasImage;
    const hasExerciseIntent =
      exerciseKeywords.some((keyword) => text.includes(keyword)) ||
      hasExerciseMedia;

    if (analysisKeywords.some((keyword) => text.includes(keyword))) {
      return 'analysis';
    }
    if (hasFoodIntent && hasExerciseIntent) {
      return 'analysis';
    }
    if (hasExerciseIntent) {
      return 'exercise';
    }
    if (hasFoodIntent) {
      return 'food';
    }
    return 'chat';
  }

  private formatUsageFooter(
    usage?: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      estimated?: boolean;
    } | null
  ): string {
    if (!usage) return '';
    const suffix = usage.estimated ? ' (estimated)' : '';
    const cost =
      (0.075 * usage.inputTokens + 0.3 * usage.outputTokens) / 1000000;

    return `\n\n<code>AI cost: in ${usage.inputTokens}, out ${usage.outputTokens}, total ${usage.totalTokens} tokens${suffix} \n\n if gemini 3.1 flash lite: ${cost.toFixed(6)} $</code>`;
  }

  async processMessage(
    chatId: number,
    user: TelegramUser,
    msg: TelegramBot.Message
  ): Promise<void> {
    this.bot!.sendChatAction(chatId, 'typing');

    const typingInterval = setInterval(() => {
      this.bot!.sendChatAction(chatId, 'typing').catch(() => {});
    }, 4000);

    try {
      const contentParts = await this.buildContentParts(chatId, msg);
      if (!contentParts) {
        return;
      }

      const aiService = await chatRepository.getActiveAiServiceSetting(user.id);
      if (!aiService) {
        return this.bot!.sendMessage(
          chatId,
          'No AI service configured. Please check your settings in the web app.'
        ) as unknown as void;
      }

      const contextMode = this.classifyContextMode(msg);
      const historyLimit = contextMode === 'chat' ? 3 : 7;
      const chatHistory = (
        (await chatRepository.getChatHistoryByUserId(
          user.id
        )) as unknown as Record<string, unknown>[]
      ).slice(-historyLimit);
      const includeFoodContext =
        contextMode === 'food' || contextMode === 'analysis';
      const includeExerciseContext =
        contextMode === 'exercise' || contextMode === 'analysis';
      const includePlanContext = includeFoodContext;

      const [exerciseSummary, nutritionContext] = await Promise.all([
        includeExerciseContext
          ? this.getExerciseSummary(user)
          : Promise.resolve(''),
        includeFoodContext
          ? TelegramAiService.getUserNutritionContext(user.id)
          : Promise.resolve(''),
      ]);
      const extraContext = '';
      const userPlan = includePlanContext ? aiService.system_prompt || '' : '';

      const processAiTurn = async (forceDataRequest: string | null = null) => {
        const historyContext = (chatHistory as Record<string, unknown>[]).map(
          (h: Record<string, unknown>) => {
            const item = h as {
              created_at?: string;
              message_type: string;
              content: string;
            };
            const ts = item.created_at
              ? new Date(item.created_at).toLocaleString('uk-UA', {
                  timeZone: (user as { timezone?: string }).timezone || 'UTC',
                  hour12: false,
                })
              : '';
            return {
              role: (item.message_type === 'user' ? 'user' : 'assistant') as
                | 'user'
                | 'assistant',
              content: ts ? `[${ts}] ${item.content}` : item.content,
            };
          }
        );

        const contextBlock = TelegramAiService.buildContextBlock(
          user,
          exerciseSummary,
          nutritionContext,
          extraContext,
          userPlan
        );
        const fullMessages = [
          { role: 'system', content: contextBlock },
          ...historyContext,
          {
            role: 'user',
            content: forceDataRequest ? forceDataRequest : contentParts,
          },
        ];
        log(
          'info',
          `[TELEGRAM AI] Sending to AI for user ${user.id}:\n` +
            `--- SYSTEM CONTEXT ---\n${contextBlock}\n` +
            `--- HISTORY (${historyContext.length} msgs) ---\n` +
            historyContext
              .map(
                (m: { role: string; content: string }, i: number) =>
                  `[${i + 1}] ${m.role}: ${m.content}`
              )
              .join('\n') +
            `\n--- USER MESSAGE ---\n${forceDataRequest ? forceDataRequest : JSON.stringify(contentParts)}`
        );

        const response = await chatService.processChatMessage(
          fullMessages as ChatMessage[],
          aiService.id as string,
          user.id
        );

        if (response && response.intent === 'request_data') {
          const waitMsg = response.text || response.content;
          if (waitMsg && waitMsg.trim() !== '') {
            await this.bot!.sendMessage(chatId, waitMsg, {
              parse_mode: 'HTML',
            }).catch(() => {});
          }

          log(
            'info',
            `[TELEGRAM BOT] Intent 'request_data' received. Params: ${JSON.stringify(response.data)}`
          );
          return this.handleDataRequest(
            chatId,
            user,
            (response.data || {}) as Record<string, unknown>,
            msg.text || '',
            aiService?.id || '',
            chatHistory as Record<string, unknown>[]
          );
        }
        return response;
      };

      const resp = await processAiTurn();
      const response = resp as {
        text?: string;
        content?: string;
        intent?: string;
        data?: unknown;
        usage?: {
          inputTokens: number;
          outputTokens: number;
          totalTokens: number;
        };
      };

      if (response && (response.text || response.content)) {
        const rawReplyText =
          (response.text as string) || (response.content as string) || '';
        let processedReplyText = rawReplyText;
        if (rawReplyText.trimStart().startsWith('{')) {
          try {
            const j = JSON.parse(rawReplyText) as {
              response?: string;
              responseText?: string;
            };
            if (j.response || j.responseText)
              processedReplyText = (j.response || j.responseText) as string;
          } catch {
            // ignore
          }
        }
        const replyText = processedReplyText.replace(/<br\s*\/?>/gi, '\n');
        const replyWithUsage = `${replyText}${this.formatUsageFooter(response.usage) || ''}`;
        await chatRepository.saveChatMessage(
          user.id,
          msg.text || '[Multi-modal]',
          'user'
        );
        await chatRepository.saveChatMessage(
          user.id,
          replyText,
          'assistant',
          response.usage ? { usage: response.usage } : null
        );

        await this.bot!.sendMessage(chatId, replyWithUsage, {
          parse_mode: 'HTML',
        });

        if (response.intent && response.intent !== 'request_data') {
          await this.tryExecuteIntent(
            chatId,
            user,
            response as Record<string, unknown>
          );
        }
      }
    } catch (error: unknown) {
      log('error', '[TELEGRAM BOT] Error processing message:', error);
      await this.bot!.sendMessage(
        chatId,
        `❌ AI Error: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      clearInterval(typingInterval);
    }
  }

  private async handleDataRequest(
    chatId: number,
    user: TelegramUser,
    dataParams: Record<string, unknown>,
    originalMsgText: string,
    aiServiceId: string,
    chatHistory: Record<string, unknown>[]
  ): Promise<unknown> {
    this.bot!.sendChatAction(chatId, 'typing');
    const typingInterval = setInterval(() => {
      this.bot!.sendChatAction(chatId, 'typing').catch(() => {});
    }, 4000);

    try {
      const type = (dataParams?.type as string) || 'exercise_history';
      const days = parseInt(dataParams?.days as string) || 14;
      let fetchedDataText = '';

      const tz = await loadUserTimezone(user.id);
      const today = todayInZone(tz);
      const endDate = today;
      const startDate = addDays(today, -(Math.max(days, 1) - 1));

      if (type.includes('exercise')) {
        const exercises = await exerciseEntry.getExerciseEntriesByDateRange(
          user.id,
          startDate,
          endDate
        );
        if (!exercises || exercises.length === 0) {
          fetchedDataText = `No exercises found in the last ${days} days.`;
        } else {
          fetchedDataText = exercises
            .map((ex: Record<string, unknown>) => {
              const item = ex as {
                entry_date?: string;
                exercise_name?: string;
                name?: string;
                duration_minutes: number;
                calories: number;
              };
              const date = item.entry_date
                ? instantToDay(
                    item.entry_date,
                    (user as { timezone?: string }).timezone || 'UTC'
                  )
                : 'Unknown';
              return `- ${date}: ${item.exercise_name || item.name} (${item.duration_minutes}m, ${Math.round(item.calories)}kcal)`;
            })
            .join('\n');
        }
      } else if (type.includes('food')) {
        const foods = await foodEntryRepository.getFoodEntriesByDateRange(
          user.id,
          startDate,
          endDate
        );
        if (!foods || foods.length === 0) {
          fetchedDataText = `No food logs found in the last ${days} days.`;
        } else {
          fetchedDataText = foods
            .map((f: Record<string, unknown>) => {
              const item = f as {
                entry_date: string;
                food_name: string;
                calories: number;
              };
              return `- ${item.entry_date}: ${item.food_name} (${Math.round(item.calories)}kcal)`;
            })
            .join('\n');
        }
      } else {
        fetchedDataText = 'Requested data type not recognized.';
      }

      log(
        'info',
        `[TELEGRAM BOT] Fetched data for ${type}:\n${fetchedDataText}`
      );

      const extraContext = `\n[SYSTEM UPDATE: The requested data has been fetched below. Use this to respond:]\n${fetchedDataText}\n\nCRITICAL INSTRUCTION: You MUST use the 'chat' intent to summarize the list above. It is STRICTLY FORBIDDEN to use 'request_data' intent now, as the data is already in this prompt.`;
      const contextBlock = TelegramAiService.buildContextBlock(
        user,
        '',
        extraContext
      );

      const historyContext = chatHistory.map((h: Record<string, unknown>) => {
        const item = h as {
          created_at?: string;
          message_type: string;
          content: string;
        };
        const ts = item.created_at
          ? new Date(item.created_at).toLocaleString('uk-UA', {
              timeZone: (user as { timezone?: string }).timezone || 'UTC',
              hour12: false,
            })
          : '';
        return {
          role: item.message_type === 'user' ? 'user' : 'assistant',
          content: ts ? `[${ts}] ${item.content}` : item.content,
        };
      });

      const fullMessages = [
        { role: 'system', content: contextBlock },
        ...historyContext,
        {
          role: 'user',
          content:
            '[SYSTEM: Data fetched. Read the SYSTEM UPDATE above and summarize the entries provided.]',
        },
      ];

      log(
        'info',
        `[TELEGRAM BOT] Second AI request payload prepared for user ${user.id}. Context Block contains fetched data.`
      );

      const response = await chatService.processChatMessage(
        fullMessages as ChatMessage[],
        aiServiceId,
        user.id
      );

      log(
        'info',
        `[TELEGRAM BOT] Second AI response received. Intent: ${response?.intent}, Text: ${response?.text?.substring(0, 100)}...`
      );

      return response;
    } catch (error: unknown) {
      log('error', '[TELEGRAM BOT] Error handling data request:', error);
      await this.bot!.sendMessage(
        chatId,
        `❌ AI Data Fetch Error: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      clearInterval(typingInterval);
    }
  }

  async tryExecuteIntent(
    chatId: number,
    user: TelegramUser,
    response: Record<string, unknown>
  ): Promise<void> {
    try {
      const tz = await loadUserTimezone(user.id);
      const today = todayInZone(tz);

      const result = await executeIntent(
        response.intent as string,
        (response.data || {}) as Record<string, unknown>,
        response.entryDate as string | null,
        user.id,
        today
      );

      if (typeof result === 'string') {
        await this.bot!.sendMessage(chatId, result, { parse_mode: 'HTML' });
      } else if (result && (result as Record<string, unknown>).message) {
        await this.bot!.sendMessage(
          chatId,
          (result as Record<string, unknown>).message as string,
          {
            parse_mode: 'HTML',
          }
        );
      } else if (
        result &&
        (result as Record<string, unknown>).intent === 'confirm_deletion'
      ) {
        const t = getTranslations(user.language);
        const matches = ((result as Record<string, unknown>).matches ||
          []) as Record<string, unknown>[];
        if (matches.length === 0) return;

        let confirmText = `❓ <b>${t.deleteConfirm}</b>\n\n`;
        const buttons: TelegramBot.InlineKeyboardButton[][] = [];

        for (const m of matches) {
          if (m.type === 'food') {
            confirmText += `🍏 ${m.name} (${Math.round(m.calories as number)} kcal)\n`;
            buttons.push([
              {
                text: `🗑️ ${t.deleteRecord}: ${m.name}`,
                callback_data: `del_f:${m.id}`,
              },
            ]);
          } else if (m.type === 'measurement') {
            confirmText += `⚖️ ${m.subType}: ${m.value} ${m.unit || ''}\n`;
            buttons.push([
              {
                text: `🗑️ ${t.deleteRecord}: ${m.subType}`,
                callback_data: `del_m:${m.id},${m.subType}`,
              },
            ]);
          }
        }

        buttons.push([
          { text: t.cancelDeleteBtn, callback_data: 'cancel_del' },
        ]);

        await this.bot!.sendMessage(chatId, confirmText, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: buttons },
        });
      }
    } catch (error: unknown) {
      log('error', '[TELEGRAM BOT] Intent execution error:', error);
    }
  }

  async handleDirectTodayLog(
    chatId: number,
    user: TelegramUser
  ): Promise<void> {
    try {
      const tz = await loadUserTimezone(user.id);
      const today = todayInZone(tz);

      const client = await poolManager.getSystemClient();
      const result = await client.query(
        'SELECT * FROM food_entries WHERE user_id = $1 AND entry_date = $2',
        [user.id, today]
      );
      const todayFood = result.rows;
      client.release();

      if (todayFood.length === 0) {
        return this.bot!.sendMessage(
          chatId,
          'No food entries for today.'
        ) as unknown as void;
      }

      let text = `🍴 <b>Today's Diary (${today}):</b>\n\n`;
      let totalCals = 0;

      const grouped: Record<string, Record<string, unknown>[]> = {
        breakfast: [],
        lunch: [],
        dinner: [],
        snacks: [],
      };

      todayFood.forEach((f: unknown) => {
        const item = f as { meal_type?: string; calories?: number };
        const type = item.meal_type || 'snacks';
        if (grouped[type]) grouped[type].push(item);
        else grouped.snacks.push(item);
        totalCals += Number(item.calories || 0);
      });

      const mealNames: { [key: string]: string } = {
        breakfast: 'Breakfast',
        lunch: 'Lunch',
        dinner: 'Dinner',
        snacks: 'Snacks',
      };

      for (const [type, items] of Object.entries(grouped)) {
        if (items.length > 0) {
          text += `<b>${mealNames[type]}:</b>\n`;
          items.forEach((i: Record<string, unknown>) => {
            const cal = i.calories
              ? `${Math.round(i.calories as number)} ккал`
              : '';
            text += ` • ${(i.food_name as string) || (i.name as string)} — ${i.quantity} ${i.unit} ${cal}\n`;
          });
          text += '\n';
        }
      }

      text += `<b>Всього:</b> ${Math.round(totalCals)} ккал`;

      const buttons: TelegramBot.InlineKeyboardButton[][] = [];
      for (const [, items] of Object.entries(grouped)) {
        if (items.length > 0) {
          items.forEach((i: Record<string, unknown>) => {
            buttons.push([
              {
                text: `🗑️ ${(i.food_name as string) || (i.name as string)} (${Math.round(i.calories as number)} kcal)`,
                callback_data: `del_f:${i.id}`,
              },
            ]);
          });
        }
      }

      this.bot!.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons },
      });
    } catch (e: unknown) {
      this.bot!.sendMessage(
        chatId,
        `❌ Помилка: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  async handleDirectRecentExercises(
    chatId: number,
    user: TelegramUser
  ): Promise<void> {
    try {
      const tz = await loadUserTimezone(user.id);
      const today = todayInZone(tz);
      const startDate = addDays(today, -6);

      let exercises = await exerciseEntry.getExerciseEntriesByDateRange(
        user.id,
        startDate,
        today
      );

      const t = getTranslations(user.language);

      if (!exercises || exercises.length === 0) {
        return this.bot!.sendMessage(
          chatId,
          t.noRecentActivities
        ) as unknown as void;
      }

      exercises = exercises.filter((ex: unknown) => {
        const item = ex as {
          exercise_name?: string;
          name?: string;
          duration_minutes?: number;
          distance?: number;
        };
        const name = (item.exercise_name || item.name || '').toLowerCase();
        if (
          name === 'active calories' &&
          !item.duration_minutes &&
          !item.distance
        ) {
          return false;
        }
        return true;
      });

      const uniqueExercisesMap = new Map<string, Record<string, unknown>>();
      exercises.forEach((ex: unknown) => {
        const item = ex as Record<string, unknown>;
        let dateStr = today;
        if (item.entry_date) {
          const d = new Date(item.entry_date as string);
          if (!isNaN(d.getTime())) {
            dateStr = instantToDay(d, user.timezone || 'UTC');
          }
        }

        const name = (
          (item.exercise_name || item.name || 'Activity') as string
        ).trim();
        const dur = Math.round((item.duration_minutes as number) || 0);

        const key = `${dateStr}|${name.toLowerCase()}|${dur}`;
        const existing = uniqueExercisesMap.get(key);

        let keepCurrent = !existing;
        if (existing) {
          const existingScore =
            ((existing.distance as number) ? 1 : 0) +
            ((existing.avg_heart_rate as number) ? 1 : 0);
          const currentScore =
            ((item.distance as number) ? 1 : 0) +
            ((item.avg_heart_rate as number) ? 1 : 0);
          if (currentScore > existingScore) {
            keepCurrent = true;
          }
        }

        if (keepCurrent) {
          uniqueExercisesMap.set(key, {
            ...item,
            entry_date_str: dateStr,
          });
        }
      });

      const processedExercises = Array.from(uniqueExercisesMap.values());
      const grouped: Record<string, Record<string, unknown>[]> = {};
      processedExercises.forEach((ex) => {
        const d = ex.entry_date_str as string;
        if (!grouped[d]) grouped[d] = [];
        grouped[d].push(ex);
      });

      let text = `${t.recentActivities}\n\n`;
      const dates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

      dates.forEach((dateString) => {
        const dParts = dateString.split('-');
        let formattedLabel = dateString;
        if (dParts.length === 3) {
          formattedLabel = `${dParts[2]}.${dParts[1]}.${dParts[0]}`;
          if (dateString === today) {
            formattedLabel += ` (${t.todayLog.split(' ')[1] || 'Today'})`;
          }
        }

        text += `📅 <b>${formattedLabel}</b>\n`;
        grouped[dateString].forEach((ex) => {
          const durationVal = Math.round(
            Number(ex.duration_minutes as string | number) || 0
          );
          const durationText = durationVal > 0 ? `${durationVal}m` : '';
          const cals = ex.calories_burned
            ? ` (${Math.round(Number(ex.calories_burned as string | number))} kcal)`
            : '';

          let emoji = '🏋️';
          const name = String(
            (ex.exercise_name as string) || (ex.name as string) || ''
          ).toLowerCase();
          if (name.includes('run')) emoji = '🏃';
          else if (name.includes('cycl') || name.includes('bike')) emoji = '🚴';
          else if (name.includes('swim')) emoji = '🏊';
          else if (name.includes('walk')) emoji = '🚶';
          else if (name.includes('hik')) emoji = '🧗';
          else if (name.includes('yoga')) emoji = '🧘';
          else if (name.includes('strength') || name.includes('press'))
            emoji = '💪';

          text += `${emoji} <b>${ex.exercise_name || ex.name}</b> — ${durationText}${cals}\n`;

          const details = [];
          if (ex.distance) {
            details.push(
              `📍 ${Number(ex.distance as string | number).toFixed(2)} km`
            );
          }
          if (ex.avg_heart_rate) {
            details.push(
              `❤️ ${Math.round(Number(ex.avg_heart_rate as string | number))} bpm`
            );
          }

          if (details.length > 0) {
            text += `  <i>${details.join(' | ')}</i>\n`;
          }
        });
        text += '\n';
      });

      this.bot!.sendMessage(chatId, text.trim(), { parse_mode: 'HTML' });
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      log('error', '[TELEGRAM BOT] Error fetching exercises:', errorMessage);
      this.bot!.sendMessage(chatId, `❌ Помилка: ${errorMessage}`);
    }
  }

  private async buildContentParts(
    chatId: number,
    msg: TelegramBot.Message
  ): Promise<Record<string, unknown>[] | null> {
    const parts: Record<string, unknown>[] = [];
    let hasMedia = false;

    if (msg.text) {
      parts.push({ type: 'text', text: msg.text });
    } else if (msg.caption) {
      parts.push({ type: 'text', text: msg.caption });
    }

    // Handle photos
    if (msg.photo && msg.photo.length > 0) {
      hasMedia = true;
      const largestPhoto = msg.photo[msg.photo.length - 1];
      try {
        const base64Image = await this.getFileBase64(largestPhoto.file_id);
        if (base64Image) {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${base64Image}` },
          });
        }
      } catch (e: unknown) {
        log(
          'error',
          '[TELEGRAM BOT] Photo fetch error:',
          e instanceof Error ? e.message : String(e)
        );
      }
    }

    // Handle voice/video notes/audio
    if (msg.voice || msg.audio || msg.video_note || msg.video || msg.document) {
      hasMedia = true;
      const fileId =
        msg.voice?.file_id ||
        msg.audio?.file_id ||
        msg.video_note?.file_id ||
        msg.video?.file_id ||
        msg.document?.file_id;
      try {
        const base64Data = await this.getFileBase64(fileId!);
        if (base64Data) {
          log(
            'info',
            `[TELEGRAM BOT] Fetched media file of length ${base64Data.length}`
          );
          // Для сучасних моделей (як-от Gemini 1.5 Pro) ми можемо відправити аудіо/відео через data url або inline_data
          // Тут ми визначаємо mime-type для базових форматів, які підтримує Telegram
          let mimeType = 'application/octet-stream';
          if (msg.voice || msg.audio) mimeType = 'audio/ogg'; // Telegram voice notes are usually ogg
          if (msg.video || msg.video_note) mimeType = 'video/mp4';

          parts.push({
            type: 'image_url', // Використовуємо image_url, бо наш chatService.ts перетворює його на inline_data для Gemini
            image_url: { url: `data:${mimeType};base64,${base64Data}` },
          });
        }
      } catch (e: unknown) {
        log(
          'error',
          '[TELEGRAM BOT] Media fetch error:',
          e instanceof Error ? e.message : String(e)
        );
      }
    }

    if (parts.length === 0 && !hasMedia) {
      return null;
    }

    return parts.length > 0 ? parts : null;
  }

  private async getFileBase64(fileId: string): Promise<string | null> {
    if (!this.bot) return null;
    try {
      const file = await this.bot.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const response = await axios.get(fileUrl, {
        responseType: 'arraybuffer',
      });
      return Buffer.from(response.data, 'binary').toString('base64');
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      log(
        'error',
        '[TELEGRAM BOT] Error downloading file from Telegram:',
        errorMessage
      );
      return null;
    }
  }

  private async findUserAndLanguageByChatId(
    chatId: number
  ): Promise<TelegramUser | null> {
    const client = await poolManager.getSystemClient();
    try {
      const result = await client.query(
        `SELECT u.id, u.name, p.language, u.telegram_chat_id, p.timezone 
         FROM public."user" u
         LEFT JOIN user_preferences p ON u.id = p.user_id
         WHERE u.telegram_chat_id = $1`,
        [chatId.toString()]
      );
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }

  private async getExerciseSummary(user: TelegramUser): Promise<string> {
    try {
      const userId = user.id;
      const tz = user?.timezone || 'UTC';
      const today = todayInZone(tz);
      const startDate = addDays(today, -6);
      const endDate = today;
      const exercises = await exerciseEntry.getExerciseEntriesByDateRange(
        userId,
        startDate,
        endDate
      );

      if (!exercises || exercises.length === 0)
        return 'No exercises in the last 7 days.';

      return exercises
        .map((ex: unknown) => {
          const item = ex as {
            entry_date?: string;
            exercise_name?: string;
            name?: string;
            duration_minutes: number;
            calories_burned: number;
          };
          const date = item.entry_date
            ? instantToDay(item.entry_date, tz)
            : 'Unknown';
          return `- ${date}: ${item.exercise_name || item.name} (${item.duration_minutes}m, ${item.calories_burned}kcal)`;
        })
        .join('\n');
    } catch {
      return 'Error fetching exercise summary.';
    }
  }

  private async setLanguage(userId: string, lang: string): Promise<void> {
    const client = await poolManager.getSystemClient();
    try {
      await client.query(
        'UPDATE user_preferences SET language = $1 WHERE user_id = $2',
        [lang, userId]
      );
    } finally {
      client.release();
    }
  }

  private async formatProfileResponse(
    userId: string,
    lang: string
  ): Promise<string> {
    // Simplified profile formatter
    return `👤 <b>Profile Info</b>\nUser ID: ${userId}\nLanguage: ${lang}`;
  }

  private getMainMenuKeyboard(
    t: TranslationSet
  ): TelegramBot.SendMessageOptions {
    return {
      reply_markup: {
        keyboard: [
          [{ text: t.profile }, { text: t.diary }],
          [{ text: t.syncMenu }, { text: t.language }],
          [{ text: t.addWater }],
        ],
        resize_keyboard: true,
      },
    };
  }

  private getDiaryMenuKeyboard(
    t: TranslationSet
  ): TelegramBot.SendMessageOptions {
    return {
      reply_markup: {
        keyboard: [
          [{ text: t.todayLog }],
          [{ text: t.exercises }],
          [{ text: t.back }],
        ],
        resize_keyboard: true,
      },
    };
  }

  private async showLanguageMenu(chatId: number): Promise<void> {
    await this.bot!.sendMessage(chatId, 'Оберіть мову / Choose language:', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🇺🇦 Українська', callback_data: 'setlang:uk' },
            { text: '🇬🇧 English', callback_data: 'setlang:en' },
            { text: '🇷🇺 Русский', callback_data: 'setlang:ru' },
          ],
        ],
      },
    });
  }

  private async showSyncMenu(chatId: number, lang: string): Promise<void> {
    const t = getTranslations(lang);
    await this.bot!.sendMessage(
      chatId,
      'Choose a platform for synchronization:',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: t.syncGarmin, callback_data: 'sync:garmin' }],
            [{ text: t.syncMFP, callback_data: 'sync:mfp' }],
            [{ text: t.back, callback_data: 'main_menu' }],
          ],
        },
      }
    );
  }
}

export default new TelegramBotService();
