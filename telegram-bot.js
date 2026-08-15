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

    onClaim(callback) {
        this.callbacks.claim = callback;
    }

    onProfit(callback) {
        this.callbacks.profit = callback;
    }

    onBetOnce(callback) {
        this.callbacks.betOnce = callback;
    }

    // Check if user is authorized
    isAuthorized(chatId) {
        return this.allowedChatIds.length === 0 || 
               this.allowedChatIds.includes(chatId.toString());
    }

    // Start listening for commands
    // Register the command list so Telegram shows a menu when the user types "/"
    async registerCommandMenu() {
        const commands = [
            { command: 'start', description: 'Start trading bot' },
            { command: 'betonce', description: 'Place ONE bet, then stop (win or lose)' },
            { command: 'stop', description: 'Stop trading bot' },
            { command: 'reset', description: 'Reset bet sequence to base' },
            { command: 'continue', description: 'Continue current streak' },
            { command: 'settings', description: 'View status & settings' },
            { command: 'profit', description: 'Session profit since /start' },
            { command: 'balance', description: 'Check wallet balance' },
            { command: 'claim', description: 'Claim all unclaimed winnings' },
            { command: 'stats', description: 'View trading statistics' },
            { command: 'setbet', description: 'Set base bet (e.g. /setbet 0.02)' },
            { command: 'setmax', description: 'Set max double-downs, 0-15' },
            { command: 'setdirection', description: 'Set direction (BULL/BEAR/RANDOM)' },
            { command: 'setprediction', description: 'Toggle early prediction on/off' },
            { command: 'setthreshold', description: 'Set prediction threshold' },
            { command: 'setmaxepbet', description: 'Set max early prediction bet' },
            { command: 'commands', description: 'Show all commands' },
            { command: 'help', description: 'Show help' }
        ];
        
        try {
            await this.bot.setMyCommands(commands);
            console.log('📋 Telegram command menu registered');
        } catch (e) {
            console.error('Could not register command menu:', e.message);
        }
    }

    start() {
        // Register the "/" command menu
        this.registerCommandMenu();
        
        // /start command
        this.bot.onText(/\/start/, async (msg) => {
            const chatId = msg.chat.id;
            
            if (!this.isAuthorized(chatId)) {
                await this.bot.sendMessage(chatId, '🚫 Unauthorized');
                return;
            }

            if (this.callbacks.start) {
                const result = await this.callbacks.start();
                await this.bot.sendMessage(chatId, result, { parse_mode: 'HTML' });
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
                `/betonce - Place ONE bet, then stop (win or lose)\n` +
                `/stop - Stop trading bot\n` +
                `/reset - Reset bet sequence to base\n` +
                `/continue - Continue current streak\n` +
                `/claim - Claim all unclaimed winnings\n` +
                `/claim [round] - Claim a specific round\n\n` +
                `<b>Settings:</b>\n` +
                `/setbet [amount] - Set base bet (e.g. /setbet 0.02)\n` +
                `/setmax [number] - Set max double-downs, 0-15 (0 = single round)\n` +
                `/setdirection [dir] - Set direction (BULL/BEAR/RANDOM)\n` +
                `/setprediction [on/off] - Toggle early prediction\n` +
                `/setthreshold [amount] - Set prediction threshold\n` +
                `/setmaxepbet [amount] - Set max early prediction bet\n` +
                `/settings - View status & settings (or /status)\n\n` +
                `<b>Info:</b>\n` +
                `/balance - Check wallet balance\n` +
                `/profit - Session profit since /start\n` +
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
                `/betonce - Place ONE bet, then stop (win or lose)\n` +
                `/stop - Stop trading bot\n` +
                `/reset - Reset bet sequence to base\n` +
                `/continue - Continue current streak\n` +
                `/claim - Claim all unclaimed winnings\n` +
                `/claim [round] - Claim a specific round\n\n` +
                `<b>Settings:</b>\n` +
                `/setbet [amount] - Set base bet (e.g. /setbet 0.02)\n` +
                `/setmax [number] - Set max double-downs, 0-15 (0 = single round)\n` +
                `/setdirection [dir] - Set direction (BULL/BEAR/RANDOM)\n` +
                `/setprediction [on/off] - Toggle early prediction\n` +
                `/setthreshold [amount] - Set prediction threshold\n` +
                `/setmaxepbet [amount] - Set max early prediction bet\n` +
                `/settings - View status & settings (or /status)\n\n` +
                `<b>Info:</b>\n` +
                `/balance - Check wallet balance\n` +
                `/profit - Session profit since /start\n` +
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

        // /profit command - show session profit since last /start
        this.bot.onText(/\/profit/, async (msg) => {
            const chatId = msg.chat.id;
            
            if (!this.isAuthorized(chatId)) {
                await this.bot.sendMessage(chatId, '🚫 Unauthorized');
                return;
            }

            if (this.callbacks.profit) {
                const result = await this.callbacks.profit();
                await this.bot.sendMessage(chatId, result, { parse_mode: 'HTML' });
            }
        });

        // /betonce command - place a single bet with current settings, then stop
        this.bot.onText(/\/betonce/, async (msg) => {
            const chatId = msg.chat.id;
            
            if (!this.isAuthorized(chatId)) {
                await this.bot.sendMessage(chatId, '🚫 Unauthorized');
                return;
            }

            if (this.callbacks.betOnce) {
                const result = await this.callbacks.betOnce();
                await this.bot.sendMessage(chatId, result, { parse_mode: 'HTML' });
            }
        });

        // /claim command - claim all unclaimed winning rounds, or a specific round
        this.bot.onText(/\/claim(?:\s+(\d+))?/, async (msg, match) => {
            const chatId = msg.chat.id;
            
            if (!this.isAuthorized(chatId)) {
                await this.bot.sendMessage(chatId, '🚫 Unauthorized');
                return;
            }

            const specificRound = match && match[1] ? parseInt(match[1]) : null;

            if (this.callbacks.claim) {
                if (specificRound) {
                    await this.bot.sendMessage(chatId, `🔍 Claiming round ${specificRound}...`, { parse_mode: 'HTML' });
                } else {
                    await this.bot.sendMessage(chatId, '🔍 Scanning for unclaimed winnings...', { parse_mode: 'HTML' });
                }
                const result = await this.callbacks.claim(specificRound);
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
