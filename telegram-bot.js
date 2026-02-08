// Telegram Bot Integration for PancakeSwap Prediction Bot
import TelegramBot from 'node-telegram-bot-api';

export class TelegramNotifier {
    constructor(botToken, chatId) {
        if (!botToken || !chatId) {
            throw new Error('Telegram bot token and chat ID required');
        }
        
        this.bot = new TelegramBot(botToken, { polling: false });
        this.chatId = chatId;
        this.enabled = true;
    }

    async sendMessage(message, options = {}) {
        if (!this.enabled) return;
        
        try {
            await this.bot.sendMessage(this.chatId, message, {
                parse_mode: 'HTML',
                ...options
            });
        } catch (error) {
            console.error('Telegram send error:', error.message);
        }
    }

    async notifyBotStarted(config) {
        await this.sendMessage(
            `🤖 <b>BOT STARTED</b>\n\n` +
            `💰 Base Bet: ${config.baseBetAmount} BNB\n` +
            `🎯 Max Double-Downs: ${config.maxDoubleDowns}\n` +
            `⚡ Ready to trade!`
        );
    }

    async notifyBotStopped(reason = 'Manual stop') {
        await this.sendMessage(
            `🛑 <b>BOT STOPPED</b>\n\n` +
            `Reason: ${reason}`
        );
    }

    async notifyBetPlaced(round, direction, amount) {
        await this.sendMessage(
            `🎲 <b>BET PLACED</b>\n\n` +
            `Round: #${round}\n` +
            `Direction: ${direction}\n` +
            `Amount: ${amount} BNB`
        );
    }

    async notifyWin(round, direction, amount, winnings) {
        await this.sendMessage(
            `🎉 <b>WIN!</b>\n\n` +
            `Round: #${round}\n` +
            `Direction: ${direction}\n` +
            `Bet: ${amount} BNB\n` +
            `💰 Profit: +${winnings} BNB`
        );
    }

    async notifyLoss(round, direction, amount, nextBet, lossStreak, maxLosses) {
        const message = lossStreak >= maxLosses
            ? `❌ <b>LOSS - MAX STREAK REACHED!</b>\n\n` +
              `Round: #${round}\n` +
              `Direction: ${direction}\n` +
              `Lost: ${amount} BNB\n\n` +
              `🛑 <b>Loss Streak: ${lossStreak}/${maxLosses}</b>\n` +
              `⚠️ <b>BOT STOPPED FOR SAFETY</b>\n\n` +
              `Please review and restart manually.`
            : `❌ <b>LOSS</b>\n\n` +
              `Round: #${round}\n` +
              `Direction: ${direction}\n` +
              `Lost: ${amount} BNB\n\n` +
              `📈 Next bet: ${nextBet} BNB\n` +
              `Loss Streak: ${lossStreak}/${maxLosses}`;
        
        await this.sendMessage(message);
    }

    async notifyLowBalance(balance, requiredAmount) {
        await this.sendMessage(
            `⚠️ <b>LOW BALANCE WARNING</b>\n\n` +
            `Current: ${balance} BNB\n` +
            `Required: ${requiredAmount} BNB\n\n` +
            `🛑 Bot stopped - please add funds`
        );
    }

    async notifyStats(stats) {
        const winRate = stats.totalBets > 0 
            ? ((stats.wins / stats.totalBets) * 100).toFixed(1) 
            : 0;
        
        const netProfit = (stats.totalWon - stats.totalWagered).toFixed(4);
        const profitEmoji = parseFloat(netProfit) >= 0 ? '📈' : '📉';

        await this.sendMessage(
            `📊 <b>TRADING STATS</b>\n\n` +
            `Total Bets: ${stats.totalBets}\n` +
            `✅ Wins: ${stats.wins}\n` +
            `❌ Losses: ${stats.losses}\n` +
            `🎯 Win Rate: ${winRate}%\n\n` +
            `💵 Wagered: ${stats.totalWagered.toFixed(4)} BNB\n` +
            `${profitEmoji} Net P/L: ${netProfit} BNB\n\n` +
            `🔥 Current Streak: ${stats.consecutiveLosses} losses\n` +
            `💰 Next Bet: ${stats.currentBet} BNB`
        );
    }

    async notifyError(error) {
        await this.sendMessage(
            `🚨 <b>ERROR</b>\n\n` +
            `${error}`
        );
    }

    disable() {
        this.enabled = false;
    }

    enable() {
        this.enabled = true;
    }
}

// Command handler for controlling bot via Telegram
export class TelegramController {
    constructor(botToken, allowedChatIds = []) {
        this.bot = new TelegramBot(botToken, { polling: true });
        this.allowedChatIds = allowedChatIds;
        this.callbacks = {};
    }

    // Register callbacks for bot control
    onStart(callback) {
        this.callbacks.start = callback;
    }

    onStop(callback) {
        this.callbacks.stop = callback;
    }

    onStatus(callback) {
        this.callbacks.status = callback;
    }

    onBalance(callback) {
        this.callbacks.balance = callback;
    }

    onStats(callback) {
        this.callbacks.stats = callback;
    }

    onReset(callback) {
        this.callbacks.reset = callback;
    }

    onContinue(callback) {
        this.callbacks.continue = callback;
    }

    onSetBet(callback) {
        this.callbacks.setBet = callback;
    }

    onSetMax(callback) {
        this.callbacks.setMax = callback;
    }

    onSetDirection(callback) {
        this.callbacks.setDirection = callback;
    }

    onSetPrediction(callback) {
        this.callbacks.setPrediction = callback;
    }

    onSetThreshold(callback) {
        this.callbacks.setThreshold = callback;
    }
    
    onSetMaxEPBet(callback) {
        this.callbacks.setMaxEPBet = callback;
    }

    onSettings(callback) {
        this.callbacks.settings = callback;
    }

    // Check if user is authorized
    isAuthorized(chatId) {
        return this.allowedChatIds.length === 0 || 
               this.allowedChatIds.includes(chatId.toString());
    }

    // Start listening for commands
    start() {
        // /start command
        this.bot.onText(/\/start/, async (msg) => {
            const chatId = msg.chat.id;
            
            if (!this.isAuthorized(chatId)) {
                await this.bot.sendMessage(chatId, '🚫 Unauthorized');
                return;
            }

            if (this.callbacks.start) {
                const result = await this.callbacks.start();
                await this.bot.sendMessage(chatId, result);
            }
        });

        // /stop command
        this.bot.onText(/\/stop/, async (msg) => {
            const chatId = msg.chat.id;
            
            if (!this.isAuthorized(chatId)) {
                await this.bot.sendMessage(chatId, '🚫 Unauthorized');
                return;
            }

            if (this.callbacks.stop) {
                const result = await this.callbacks.stop();
                await this.bot.sendMessage(chatId, result);
            }
        });

        // /status command (merged with settings)
        this.bot.onText(/\/status/, async (msg) => {
            const chatId = msg.chat.id;
            
            if (!this.isAuthorized(chatId)) {
                await this.bot.sendMessage(chatId, '🚫 Unauthorized');
                return;
            }

            if (this.callbacks.settings) {
                const result = await this.callbacks.settings();
                await this.bot.sendMessage(chatId, result, { parse_mode: 'HTML' });
            }
        });

        // /balance command
        this.bot.onText(/\/balance/, async (msg) => {
            const chatId = msg.chat.id;
            
            if (!this.isAuthorized(chatId)) {
                await this.bot.sendMessage(chatId, '🚫 Unauthorized');
                return;
            }

            if (this.callbacks.balance) {
                const result = await this.callbacks.balance();
                await this.bot.sendMessage(chatId, result, { parse_mode: 'HTML' });
            }
        });

        // /stats command
        this.bot.onText(/\/stats/, async (msg) => {
            const chatId = msg.chat.id;
            
            if (!this.isAuthorized(chatId)) {
                await this.bot.sendMessage(chatId, '🚫 Unauthorized');
                return;
            }

            if (this.callbacks.stats) {
                const result = await this.callbacks.stats();
                await this.bot.sendMessage(chatId, result, { parse_mode: 'HTML' });
            }
        });

        // /help command
        this.bot.onText(/\/help/, async (msg) => {
            const chatId = msg.chat.id;
            
            const helpText = 
                `🤖 <b>Bot Commands</b>\n\n` +
                `<b>Control:</b>\n` +
                `/start - Start trading bot\n` +
                `/stop - Stop trading bot\n` +
                `/reset - Reset bet sequence to base\n` +
                `/continue - Continue current streak\n\n` +
                `<b>Settings:</b>\n` +
                `/setbet [amount] - Set base bet (e.g. /setbet 0.02)\n` +
                `/setmax [number] - Set max double-downs (e.g. /setmax 3)\n` +
                `/setdirection [dir] - Set direction (BULL/BEAR/RANDOM)\n` +
                `/setprediction [on/off] - Toggle early prediction\n` +
                `/setthreshold [amount] - Set prediction threshold\n` +
                `/setmaxepbet [amount] - Set max early prediction bet\n` +
                `/settings - View status & settings (or /status)\n\n` +
                `<b>Info:</b>\n` +
                `/balance - Check wallet balance\n` +
                `/stats - View trading statistics\n` +
                `/commands - Show this help message\n` +
                `/help - Show this help message`;
            
            await this.bot.sendMessage(chatId, helpText, { parse_mode: 'HTML' });
        });

        // /commands command (alias for help)
        this.bot.onText(/\/commands/, async (msg) => {
            const chatId = msg.chat.id;
            
            const helpText = 
                `🤖 <b>Bot Commands</b>\n\n` +
                `<b>Control:</b>\n` +
                `/start - Start trading bot\n` +
                `/stop - Stop trading bot\n` +
                `/reset - Reset bet sequence to base\n` +
                `/continue - Continue current streak\n\n` +
                `<b>Settings:</b>\n` +
                `/setbet [amount] - Set base bet (e.g. /setbet 0.02)\n` +
                `/setmax [number] - Set max double-downs (e.g. /setmax 3)\n` +
                `/setdirection [dir] - Set direction (BULL/BEAR/RANDOM)\n` +
                `/setprediction [on/off] - Toggle early prediction\n` +
                `/setthreshold [amount] - Set prediction threshold\n` +
                `/setmaxepbet [amount] - Set max early prediction bet\n` +
                `/settings - View status & settings (or /status)\n\n` +
                `<b>Info:</b>\n` +
                `/balance - Check wallet balance\n` +
                `/stats - View trading statistics\n` +
                `/commands - Show this help message\n` +
                `/help - Show this help message`;
            
            await this.bot.sendMessage(chatId, helpText, { parse_mode: 'HTML' });
        });

        // /reset command
        this.bot.onText(/\/reset/, async (msg) => {
            const chatId = msg.chat.id;
            
            if (!this.isAuthorized(chatId)) {
                await this.bot.sendMessage(chatId, '🚫 Unauthorized');
                return;
            }

            if (this.callbacks.reset) {
                const result = await this.callbacks.reset();
                await this.bot.sendMessage(chatId, result, { parse_mode: 'HTML' });
            }
        });

        // /continue command
        this.bot.onText(/\/continue/, async (msg) => {
            const chatId = msg.chat.id;
            
            if (!this.isAuthorized(chatId)) {
                await this.bot.sendMessage(chatId, '🚫 Unauthorized');
                return;
            }

            if (this.callbacks.continue) {
                const result = await this.callbacks.continue();
                await this.bot.sendMessage(chatId, result, { parse_mode: 'HTML' });
            }
        });

        // /settings command
        this.bot.onText(/\/settings/, async (msg) => {
            const chatId = msg.chat.id;
            
            if (!this.isAuthorized(chatId)) {
                await this.bot.sendMessage(chatId, '🚫 Unauthorized');
                return;
            }

            if (this.callbacks.settings) {
                const result = await this.callbacks.settings();
                await this.bot.sendMessage(chatId, result, { parse_mode: 'HTML' });
            }
        });

        // /setbet command
        this.bot.onText(/\/setbet (.+)/, async (msg, match) => {
            const chatId = msg.chat.id;
            
            if (!this.isAuthorized(chatId)) {
                await this.bot.sendMessage(chatId, '🚫 Unauthorized');
                return;
            }

            const amount = match[1];
            if (this.callbacks.setBet) {
                const result = await this.callbacks.setBet(amount);
                await this.bot.sendMessage(chatId, result, { parse_mode: 'HTML' });
            }
        });

        // /setmax command
        this.bot.onText(/\/setmax (.+)/, async (msg, match) => {
            const chatId = msg.chat.id;
            
            if (!this.isAuthorized(chatId)) {
                await this.bot.sendMessage(chatId, '🚫 Unauthorized');
                return;
            }

            const max = match[1];
            if (this.callbacks.setMax) {
                const result = await this.callbacks.setMax(max);
                await this.bot.sendMessage(chatId, result, { parse_mode: 'HTML' });
            }
        });

        // /setdirection command
        this.bot.onText(/\/setdirection (.+)/, async (msg, match) => {
            const chatId = msg.chat.id;
            
            if (!this.isAuthorized(chatId)) {
                await this.bot.sendMessage(chatId, '🚫 Unauthorized');
                return;
            }

            const direction = match[1].toUpperCase();
            if (this.callbacks.setDirection) {
                const result = await this.callbacks.setDirection(direction);
                await this.bot.sendMessage(chatId, result, { parse_mode: 'HTML' });
            }
        });

        // /setprediction command
        this.bot.onText(/\/setprediction (.+)/, async (msg, match) => {
            const chatId = msg.chat.id;
            
            if (!this.isAuthorized(chatId)) {
                await this.bot.sendMessage(chatId, '🚫 Unauthorized');
                return;
            }

            const value = match[1].toLowerCase();
            if (this.callbacks.setPrediction) {
                const result = await this.callbacks.setPrediction(value);
                await this.bot.sendMessage(chatId, result, { parse_mode: 'HTML' });
            }
        });

        // /setthreshold command
        this.bot.onText(/\/setthreshold (.+)/, async (msg, match) => {
            const chatId = msg.chat.id;
            
            if (!this.isAuthorized(chatId)) {
                await this.bot.sendMessage(chatId, '🚫 Unauthorized');
                return;
            }

            const threshold = match[1];
            if (this.callbacks.setThreshold) {
                const result = await this.callbacks.setThreshold(threshold);
                await this.bot.sendMessage(chatId, result, { parse_mode: 'HTML' });
            }
        });
        
        // /setmaxepbet command
        this.bot.onText(/\/setmaxepbet (.+)/, async (msg, match) => {
            const chatId = msg.chat.id;
            
            if (!this.isAuthorized(chatId)) {
                await this.bot.sendMessage(chatId, '🚫 Unauthorized');
                return;
            }

            const amount = match[1];
            if (this.callbacks.setMaxEPBet) {
                const result = await this.callbacks.setMaxEPBet(amount);
                await this.bot.sendMessage(chatId, result, { parse_mode: 'HTML' });
            }
        });

        console.log('Telegram controller started - listening for commands');
    }

    stop() {
        this.bot.stopPolling();
    }
}
