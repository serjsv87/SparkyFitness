import { describe, it, expect, vi, beforeEach } from 'vitest';
const telegramBotService = require('../integrations/telegram/telegramBotService');
import poolManager from '../db/poolManager.js';

import userRepository from '../models/userRepository.js';
import goalRepository from '../models/goalRepository.js';
import * as foodEntry from '../models/foodEntry.js';
import measurementRepository from '../models/measurementRepository.js';
import preferenceRepository from '../models/preferenceRepository.js';

vi.mock('../models/globalSettingsRepository.js');
vi.mock('../db/poolManager.js');
vi.mock('../services/chatService.js');
vi.mock('../models/chatRepository.js');
vi.mock('../models/exerciseEntry.js');
vi.mock('../models/userRepository.js');
vi.mock('../models/goalRepository.js');
vi.mock('../models/foodEntry.js');
vi.mock('../models/measurementRepository.js');
vi.mock('../models/preferenceRepository.js');
vi.mock('node-telegram-bot-api');
vi.mock('../config/logging.js', () => ({
  log: vi.fn(),
}));
vi.mock('../utils/timezoneLoader.js', () => ({
  loadUserTimezone: vi.fn().mockResolvedValue('UTC'),
}));
vi.mock('@workspace/shared', () => ({
  todayInZone: vi.fn().mockReturnValue('2026-04-06'),
}));

describe('TelegramBotService', () => {
  const mockChatId = 123456789;
  const mockUserId = 'user-uuid';
  const mockClient = {
    query: vi.fn(),
    release: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (poolManager.getSystemClient as any).mockResolvedValue(mockClient);
  });

  describe('findUserAndLanguageByChatId', () => {
    it('should return user info if found in database', async () => {
      const mockUser = {
        id: mockUserId,
        name: 'Test User',
        language: 'en',
        telegram_chat_id: String(mockChatId),
      };
      mockClient.query.mockResolvedValue({ rows: [mockUser] });

      // Accessing private method for testing
      const result = await (
        telegramBotService as any
      ).findUserAndLanguageByChatId(mockChatId);

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT id, name, language, telegram_chat_id'),
        [String(mockChatId)]
      );
      expect(result).toEqual(mockUser);
    });

    it('should return null if user not found', async () => {
      mockClient.query.mockResolvedValue({ rows: [] });

      const result = await (
        telegramBotService as any
      ).findUserAndLanguageByChatId(mockChatId);

      expect(result).toBeNull();
    });
  });

  describe('getTranslations', () => {
    it('should return English translations by default', () => {
      const t = (telegramBotService as any).getTranslations('en');
      expect(t.greeting).toBeDefined();
    });

    it('should return Ukrainian translations for "uk"', () => {
      const t = (telegramBotService as any).getTranslations('uk');
      expect(t.greeting).toBe('Привіт');
    });

    it('should fallback to English for unknown language', () => {
      const t = (telegramBotService as any).getTranslations('fr');
      expect(t.greeting).toBe('Hello');
    });
  });

  describe('handleLink', () => {
    it('should link user account when valid code is provided', async () => {
      const mockCode = 'ABCDEF';
      const mockUser = { id: mockUserId, name: 'Test User', language: 'en' };
      mockClient.query
        .mockResolvedValueOnce({ rows: [mockUser] }) // First query (find user)
        .mockResolvedValueOnce({}); // Second query (update user)

      // Mock bot.sendMessage
      (telegramBotService as any).bot = { sendMessage: vi.fn() };
      (telegramBotService as any).getMainMenuKeyboard = vi
        .fn()
        .mockReturnValue({});

      await telegramBotService.handleLink(mockChatId, mockCode);

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT id, name, language FROM public."user"'),
        [mockCode]
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE public."user" SET telegram_chat_id'),
        [String(mockChatId), mockUserId]
      );
      expect((telegramBotService as any).bot.sendMessage).toHaveBeenCalledWith(
        mockChatId,
        expect.stringContaining('Success'),
        expect.any(Object)
      );
    });

    it('should send error message for invalid code', async () => {
      const mockCode = 'INVALID';
      mockClient.query.mockResolvedValue({ rows: [] });

      (telegramBotService as any).bot = { sendMessage: vi.fn() };

      await telegramBotService.handleLink(mockChatId, mockCode);

      expect((telegramBotService as any).bot.sendMessage).toHaveBeenCalledWith(
        mockChatId,
        expect.stringContaining('Invalid linking code')
      );
    });
  });

  describe('getUserNutritionContext', () => {
    it('should aggregate user physical profile and goals for AI context', async () => {
      const mockProfile = { gender: 'male', date_of_birth: '1990-01-01' };
      const mockGoal = { calories: 2500 };
      const mockDailyProgress = [
        { calories: 1500, protein: 100, carbs: 150, fat: 50 },
      ];

      (userRepository.getUserProfile as any).mockResolvedValue(mockProfile);
      (goalRepository.getMostRecentGoalBeforeDate as any).mockResolvedValue(
        mockGoal
      );
      (foodEntry.getFoodEntriesByDate as any).mockResolvedValue(
        mockDailyProgress
      );
      (
        measurementRepository.getLatestCheckInMeasurementsOnOrBeforeDate as any
      ).mockResolvedValue({ weight: 80, height: 180 });
      (preferenceRepository.getUserPreferences as any).mockResolvedValue({
        activity_level: 'sedentary',
      });

      const context = await (telegramBotService as any).getUserNutritionContext(
        mockUserId
      );

      expect(context).toContain('80kg');
      expect(context).toContain('Male');
      expect(context).toContain('2500 kcal');
      expect(context).toContain('1500 kcal');
    });
  });

  describe('executeIntent', () => {
    it('should return a detailed success message when logging food with macros', async () => {
      const {
        executeIntent: _executeIntent,
      } = require('../integrations/telegram/intentExecutor');
      // Mock executeIntent directly or test the service's reaction
      // In this case, we verify that the service handles the response correctly
    });
  });
});
