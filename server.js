import { ethers } from 'ethers';
import { TelegramNotifier, TelegramController } from './telegram-bot.js';
import 'dotenv/config';

const PREDICTION_CONTRACT = '0x18B2A687610328590Bc8F2e5fEdDe3b582A49cdA';
const BET_TIMING_SECONDS = 20;
const POLLING_INTERVAL = 2000;

const PREDICTION_ABI = [
    'function betBull(uint256 epoch) external payable',
    'function betBear(uint256 epoch) external payable',
    'function claim(uint256[] calldata epochs) external',
    'function claimable(uint256 epoch, address user) external view returns (bool)',
    'function currentEpoch() external view returns (uint256)',
    'function rounds(uint256 epoch) external view returns (uint256 epoch, uint256 startTimestamp, uint256 lockTimestamp, uint256 closeTimestamp, int256 lockPrice, int256 closePrice, uint256 lockOracleId, uint256 closeOracleId, uint256 totalAmount, uint256 bullAmount, uint256 bearAmount, uint256 rewardBaseCalAmount, uint256 rewardAmount, bool oracleCalled)',
    'function ledger(uint256 epoch, address user) external view returns (uint8 position, uint256 amount, bool claimed)',
    'function getUserRounds(address user, uint256 cursor, uint256 size) external view returns (uint256[] memory, tuple(uint8 position, uint256 amount, bool claimed)[] memory, uint256)',
];

class PancakePredictionBot {
    constructor(config) {
        this.config = config;
        this.provider = null;
        this.wallet = null;
        this.contract = null;
        this.telegram = null;
        this.telegramController = null;
        this.isRunning = false;
        this.waitingForResults = false;
        this.lastBetEpoch = null;
        
        this.state = {
            consecutiveLosses: 0,
            currentBet: config.baseBetAmount,
            totalBets: 0,
            wins: 0,
            losses: 0,
            totalWagered: 0,
            totalWon: 0,
            balance: '0',
            totalLost: 0
        };
        
        // Early prediction tracking
        this.earlyPrediction = {
            realLosses: 0,           // Confirmed losses from closed rounds
            assumedLosses: 0,        // Predicted losses not yet confirmed
            lastAssumedOutcome: null, // 'win' or 'loss'
            lastAssumedBet: 0,       // The bet amount we assumed would win/lose
            lastPredictionEpoch: null, // Which epoch we made the last prediction for
            skipNextRound: false,     // Flag to skip next round after uncertain prediction
            processedRounds: new Set(), // Track rounds we've already checked to prevent duplicate processing
            shouldBetNow: false,      // Flag to bypass timing check after confident prediction
            pendingWinClaims: new Map(), // Track assumed wins that need verification: epoch → betAmount
            doubleDownCount: 0        // How many consecutive doubles we're on (for maxDoubleDowns enforcement)
        };
    }

    async getCurrentBNBPrice() {
        try {
            console.log(`📡 Getting current BNB price from Chainlink oracle...`);
            
            // Chainlink BNB/USD Price Feed on BSC
            // Address: 0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE
            const chainlinkABI = [
                {
                    "inputs": [],
                    "name": "latestRoundData",
                    "outputs": [
                        { "name": "roundId", "type": "uint80" },
                        { "name": "answer", "type": "int256" },
                        { "name": "startedAt", "type": "uint256" },
                        { "name": "updatedAt", "type": "uint256" },
                        { "name": "answeredInRound", "type": "uint80" }
                    ],
                    "stateMutability": "view",
                    "type": "function"
                }
            ];
            
            const priceFeed = new ethers.Contract(
                '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE',
                chainlinkABI,
                this.provider
            );
            
            const roundData = await priceFeed.latestRoundData();
            const price = Number(roundData[1]) / 1e8; // Chainlink uses 8 decimals
            
            console.log(`📡 Chainlink oracle price: $${price.toFixed(2)}`);
            return price;
        } catch (error) {
            console.error(`❌ Chainlink price fetch FAILED: ${error.message}`);
            return null;
        }
    }

    async initialize() {
        console.log('🚀 Initializing bot...');

        // Setup Web3
        this.provider = new ethers.JsonRpcProvider(this.config.rpcUrl);
        this.wallet = new ethers.Wallet(this.config.privateKey, this.provider);
        this.contract = new ethers.Contract(PREDICTION_CONTRACT, PREDICTION_ABI, this.wallet);
        
        const balance = await this.provider.getBalance(this.wallet.address);
        this.state.balance = ethers.formatEther(balance);

        console.log(`💰 Wallet: ${this.wallet.address}`);
        console.log(`💵 Balance: ${this.state.balance} BNB`);

        // Setup Telegram
        if (this.config.telegramBotToken && this.config.telegramChatId) {
            this.telegram = new TelegramNotifier(
                this.config.telegramBotToken,
                this.config.telegramChatId
            );
            
            this.telegramController = new TelegramController(
                this.config.telegramBotToken,
                [this.config.telegramChatId]
            );
            
            this.setupTelegramCommands();
            this.telegramController.start();
            
            console.log('📱 Telegram notifications enabled');
        }
    }

    setupTelegramCommands() {
        this.telegramController.onStart(async () => {
            if (this.isRunning) {
                return '⚠️ Bot is already running!';
            }
            this.start();
            
            // Show settings after starting
            const maxLosses = this.config.maxDoubleDowns + 1;
            return `🤖 <b>BOT STARTED</b>\n\n` +
                   `<b>⚙️ Current Settings</b>\n\n` +
                   `💰 Base Bet: ${this.config.baseBetAmount} BNB\n` +
                   `🎯 Max Double-Downs: ${this.config.maxDoubleDowns}\n` +
                   `📊 Direction: ${this.config.betDirection}\n` +
                   `🔮 Early Prediction: ${this.config.earlyPrediction ? 'ON' : 'OFF'}\n` +
                   `📈 Prediction Threshold: $${this.config.predictionThreshold}\n` +
                   `🛑 Max Early Prediction Bet: ${this.config.maxEarlyPredictionBet} BNB\n\n` +
                   `⚡ Ready to trade!`;
        });

        this.telegramController.onStop(async () => {
            if (!this.isRunning) {
                return '⚠️ Bot is not running!';
            }
            this.stop('Manual stop via Telegram');
            return '🛑 Bot stopped!';
        });

        this.telegramController.onBalance(async () => {
            const balance = await this.provider.getBalance(this.wallet.address);
            this.state.balance = ethers.formatEther(balance);
            
            return `<b>WALLET BALANCE</b>\n\n` +
                   `💰 ${this.state.balance} BNB`;
        });

        this.telegramController.onStats(async () => {
            await this.telegram.notifyStats(this.state);
            return '📊 Stats sent!';
        });

        this.telegramController.onReset(async () => {
            this.reset();
            return '✅ Sequence reset! Next /start will use base bet.';
        });

        this.telegramController.onClaim(async () => {
            return await this.claimAllWinnings();
        });

        this.telegramController.onContinue(async () => {
            if (this.state.consecutiveLosses > 0) {
                return `✅ <b>Continuing Current Streak</b>\n\n` +
                       `Next bet: ${this.state.currentBet} BNB\n` +
                       `Loss streak: ${this.state.consecutiveLosses}\n` +
                       `Total lost: ${this.state.totalLost.toFixed(6)} BNB`;
            } else {
                return '✅ No active streak. Next /start will use base bet.';
            }
        });

        this.telegramController.onSettings(async () => {
            // Status section
            const status = this.isRunning ? '🟢 RUNNING' : '🔴 STOPPED';
            const waiting = this.waitingForResults ? '⏳ Waiting for results' : '✅ Ready to bet';
            const maxLosses = this.config.maxDoubleDowns + 1; // Base bet + doubles
            
            let msg = `<b>🤖 BOT STATUS & SETTINGS</b>\n\n`;
            
            // Status info
            msg += `<b>Status:</b> ${status}\n`;
            msg += `<b>State:</b> ${waiting}\n`;
            msg += `<b>Balance:</b> ${this.state.balance} BNB\n`;
            msg += `<b>Next Bet:</b> ${this.state.currentBet} BNB\n`;
            msg += `<b>Loss Streak:</b> ${this.state.consecutiveLosses}/${maxLosses}\n\n`;
            
            // Settings info
            msg += `<b>⚙️ Configuration</b>\n\n`;
            msg += `💰 Base Bet: ${this.config.baseBetAmount} BNB\n`;
            msg += `🎯 Max Double-Downs: ${this.config.maxDoubleDowns}\n`;
            msg += `📊 Direction: ${this.config.betDirection}\n`;
            msg += `🔮 Early Prediction: ${this.config.earlyPrediction ? 'ON' : 'OFF'}\n`;
            
            if (this.config.earlyPrediction) {
                msg += `📈 Prediction Threshold: $${this.config.predictionThreshold}\n`;
                msg += `🛑 Max Early Prediction Bet: ${this.config.maxEarlyPredictionBet} BNB\n`;
            }
            
            msg += `\n<i>Use /setbet, /setmax, etc. to change settings.</i>`;
            return msg;
        });

        this.telegramController.onSetBet(async (amount) => {
            const bet = parseFloat(amount);
            if (isNaN(bet) || bet <= 0) {
                return '❌ Invalid amount. Use: /setbet 0.01';
            }
            
            if (this.isRunning) {
                return '⚠️ Stop the bot first with /stop';
            }
            
            this.config.baseBetAmount = amount;
            
            // Reset if no active streak
            if (this.state.consecutiveLosses === 0) {
                this.state.currentBet = amount;
            }
            
            return `✅ <b>Base bet updated!</b>\n\nNew base bet: ${amount} BNB\n\n` +
                   `${this.state.consecutiveLosses > 0 
                       ? '⚠️ Active streak continues with current bet.\nUse /reset to apply new base bet.' 
                       : 'Next /start will use this amount.'}`;
        });

        this.telegramController.onSetMax(async (max) => {
            const maxNum = parseInt(max);
            if (isNaN(maxNum) || maxNum < 1 || maxNum > 15) {
                return '❌ Invalid number. Use 1-15. Example: /setmax 5';
            }
            
            if (this.isRunning) {
                return '⚠️ Stop the bot first with /stop';
            }
            
            this.config.maxDoubleDowns = maxNum;
            
            // Calculate max bet
            let totalLost = 0;
            let currentBet = parseFloat(this.config.baseBetAmount);
            for (let i = 0; i < maxNum; i++) {
                totalLost += currentBet;
                currentBet = totalLost * 2;
            }
            
            return `✅ <b>Max double-downs updated!</b>\n\n` +
                   `Max double-downs: ${maxNum}\n` +
                   `Total bets allowed: ${maxNum + 1}\n` +
                   `Max bet: ${currentBet.toFixed(6)} BNB\n` +
                   `Max risk: ${(totalLost + currentBet).toFixed(6)} BNB`;
        });

        this.telegramController.onSetDirection(async (direction) => {
            if (!['BULL', 'BEAR', 'RANDOM'].includes(direction)) {
                return '❌ Invalid direction. Use: BULL, BEAR, or RANDOM';
            }
            
            if (this.isRunning) {
                return '⚠️ Stop the bot first with /stop';
            }
            
            this.config.betDirection = direction;
            
            const emoji = direction === 'BULL' ? '📈' : direction === 'BEAR' ? '📉' : '🎲';
            return `✅ <b>Direction updated!</b>\n\n${emoji} Direction: ${direction}`;
        });

        this.telegramController.onSetPrediction(async (value) => {
            if (!['on', 'off', 'true', 'false'].includes(value)) {
                return '❌ Invalid value. Use: on, off, true, or false';
            }
            
            if (this.isRunning) {
                return '⚠️ Stop the bot first with /stop';
            }
            
            const enabled = value === 'on' || value === 'true';
            this.config.earlyPrediction = enabled;
            
            return `✅ <b>Early prediction ${enabled ? 'enabled' : 'disabled'}!</b>\n\n` +
                   `${enabled 
                       ? '🔮 Bot will predict outcomes early and bet faster.\nMake sure threshold is set correctly with /setthreshold' 
                       : '⏸️ Bot will wait for round results before betting.'}`;
        });

        this.telegramController.onSetThreshold(async (threshold) => {
            const thresh = parseFloat(threshold);
            if (isNaN(thresh) || thresh < 0.05 || thresh > 2.0) {
                return '❌ Invalid threshold. Use 0.05-2.0. Example: /setthreshold 0.30';
            }
            
            if (this.isRunning) {
                return '⚠️ Stop the bot first with /stop';
            }
            
            this.config.predictionThreshold = threshold;
            
            return `✅ <b>Prediction threshold updated!</b>\n\n` +
                   `Threshold: $${threshold}\n\n` +
                   `Bot will predict outcome if price moves ±$${threshold} from lock price.`;
        });
        
        this.telegramController.onSetMaxEPBet(async (amount) => {
            const bet = parseFloat(amount);
            if (isNaN(bet) || bet <= 0) {
                return '❌ Invalid amount. Use: /setmaxepbet 1.0';
            }
            
            if (this.isRunning) {
                return '⚠️ Stop the bot first with /stop';
            }
            
            this.config.maxEarlyPredictionBet = amount;
            
            return `✅ <b>Max early prediction bet updated!</b>\n\n` +
                   `Max: ${amount} BNB\n\n` +
                   `Bot will stop if next bet exceeds this amount.`;
        });
    }

    // Calculate how many double-downs a given bet amount represents
    // Base bet = 0 doubles, first double = 1, etc.
    // Progression: base, then each step = (accumulated losses) * 2
    getDoubleDownLevel(betAmount) {
        const base = parseFloat(this.config.baseBetAmount);
        const bet = parseFloat(betAmount);
        
        // If bet is at (or below) base, it's 0 doubles
        if (bet <= base + 0.0000001) {
            return 0;
        }
        
        // Walk the Martingale progression and count steps until we reach/exceed the bet
        let accumulated = 0;
        let currentBet = base;
        let level = 0;
        
        while (level < 50) { // safety cap
            accumulated += currentBet;
            currentBet = accumulated * 2;
            level++;
            // Check if this step matches the bet amount (within rounding tolerance)
            if (Math.abs(currentBet - bet) < 0.0001 || currentBet > bet) {
                return level;
            }
        }
        return level;
    }

    calculateNextBet(consecutiveLosses, totalLost = 0) {
        const base = parseFloat(this.config.baseBetAmount);
        const maxDoubleDowns = parseInt(this.config.maxDoubleDowns);
        
        if (consecutiveLosses === 0) {
            return base.toFixed(6);
        }
        
        if (consecutiveLosses >= maxDoubleDowns) {
            let accumulated = 0;
            let currentBet = base;
            for (let i = 0; i < maxDoubleDowns; i++) {
                accumulated += currentBet;
                currentBet = accumulated * 2;
            }
            return currentBet.toFixed(6);
        }
        
        return (totalLost * 2).toFixed(6);
    }

    async tryEarlyPrediction() {
        if (!this.config.earlyPrediction) return null;
        
        try {
            if (!this.lastBetEpoch) return null;

            const round = await this.contract.rounds(this.lastBetEpoch);
            const lockTimestamp = Number(round[2]); // When betting closes
            const closeTimestamp = Number(round[3]); // When round ends (5 min after lock)
            const lockPrice = Number(round[4]) / 1e8;
            
            const now = Math.floor(Date.now() / 1000);
            const timeUntilClose = closeTimestamp - now;

            // Only make prediction if in the window (15-25s before close)
            if (timeUntilClose > 25 || timeUntilClose < 15) {
                return null;
            }
            
            console.log(`✅ IN PREDICTION WINDOW (${timeUntilClose}s until close) - Getting price snapshot...`);

            // NOW get the current price (only once, when in the window)
            const currentPrice = await this.getCurrentBNBPrice();
            if (!currentPrice) {
                console.log(`⚠️ Could not get current price for prediction`);
                return null;
            }

            const priceDiff = currentPrice - lockPrice;
            const threshold = parseFloat(this.config.predictionThreshold);
            
            console.log(
                `📊 Early Prediction Window - Round ${this.lastBetEpoch}\n` +
                `   Lock Price: $${lockPrice.toFixed(2)}\n` +
                `   Current Price: $${currentPrice.toFixed(2)}\n` +
                `   Price Diff: ${priceDiff > 0 ? '+' : ''}$${priceDiff.toFixed(2)}\n` +
                `   Threshold: ±$${threshold}\n` +
                `   Time Until Close: ${timeUntilClose}s`
            );
            
            // Get our current bet info
            const ledger = await this.contract.ledger(this.lastBetEpoch, this.wallet.address);
            const position = Number(ledger[0]);
            const betAmount = parseFloat(ethers.formatEther(ledger[1]));
            
            const direction = position === 0 ? 'BULL' : 'BEAR';
            
            // CHECK IF WITHIN SAFETY ENVELOPE (±threshold)
            if (Math.abs(priceDiff) < threshold) {
                // Price is within the envelope - TOO UNCERTAIN to predict
                console.log(
                    `⚠️ UNCERTAIN - Price movement ($${Math.abs(priceDiff).toFixed(2)}) is LESS than threshold ($${threshold})\n` +
                    `   Round ${this.lastBetEpoch} - Skipping next round to verify real results`
                );
                
                if (this.telegram) {
                    await this.telegram.sendMessage(
                        `⚠️ <b>Uncertain - No Prediction</b>\n\n` +
                        `Round: ${this.lastBetEpoch}\n` +
                        `Lock Price: $${lockPrice.toFixed(2)}\n` +
                        `Current Price: $${currentPrice.toFixed(2)}\n` +
                        `Price movement: ${priceDiff > 0 ? '+' : ''}$${priceDiff.toFixed(2)}\n` +
                        `Movement size: $${Math.abs(priceDiff).toFixed(2)}\n` +
                        `Threshold: $${threshold}\n\n` +
                        `Movement too small to predict confidently.\n` +
                        `Will skip next round and verify real results.`
                    );
                }
                
                // Return special "uncertain" flag
                return { uncertain: true };
            }
            
            // OUTSIDE ENVELOPE - Make confident assumption
            const priceWentUp = priceDiff > 0;
            
            // Assume WIN only if price movement is in our favor AND exceeds threshold
            let assumedWin = false;
            if (position === 0 && priceDiff > threshold) { // BULL and price went up enough
                assumedWin = true;
            } else if (position === 1 && Math.abs(priceDiff) > threshold && priceDiff < 0) { // BEAR and price went down enough
                assumedWin = true;
            }
            
            // Calculate total losses to cover (real + assumed)
            // These losses already include all previous bets that were lost
            let totalLossesToCover = this.earlyPrediction.realLosses + this.earlyPrediction.assumedLosses;
            
            // Calculate next bet amount FIRST (before updating assumed losses)
            let nextBet;
            if (assumedWin) {
                // Assuming win → bet base amount
                nextBet = parseFloat(this.config.baseBetAmount);
            } else {
                // Assuming loss → we expect to lose the current bet (betAmount)
                // So next bet needs to cover: existing losses + this bet
                nextBet = (totalLossesToCover + betAmount) * 2;
            }
            
            // NOW update assumed losses for tracking (after calculating next bet)
            if (assumedWin) {
                // If we assume win, we'll recover losses, so clear ALL losses
                this.earlyPrediction.realLosses = 0;
                this.earlyPrediction.assumedLosses = 0;
            } else {
                // If we assume loss, add current bet to assumed losses for tracking
                this.earlyPrediction.assumedLosses += betAmount;
            }
            
            // Check limits - BUT ONLY IF WE'RE PREDICTING A LOSS
            // If we're predicting a WIN, next bet will be base bet (no problem)
            if (!assumedWin) {
                const maxBet = parseFloat(this.config.maxEarlyPredictionBet);
                const maxDoubles = parseInt(this.config.maxDoubleDowns);
                
                // Figure out how many double-downs the NEXT bet represents
                const nextBetDoubleLevel = this.getDoubleDownLevel(nextBet);
                
                // Check BOTH limits: max bet amount AND max double-downs
                const exceedsMaxBet = nextBet > maxBet;
                const exceedsMaxDoubles = nextBetDoubleLevel > maxDoubles;
                
                if (exceedsMaxBet || exceedsMaxDoubles) {
                    let reason;
                    if (exceedsMaxBet && exceedsMaxDoubles) {
                        reason = `exceeds max bet (${maxBet} BNB) and max double-downs (${maxDoubles})`;
                    } else if (exceedsMaxBet) {
                        reason = `exceeds max bet of ${maxBet} BNB`;
                    } else {
                        reason = `exceeds max double-downs of ${maxDoubles}`;
                    }
                    
                    console.log(`🛑 STOPPING: Predicted LOSS, next bet (${nextBet.toFixed(4)} BNB, double #${nextBetDoubleLevel}) ${reason}`);
                    
                    // Send the prediction message first so user knows what was predicted
                    if (this.telegram) {
                        await this.telegram.sendMessage(
                            `🔮 <b>Confident LOSS ❌ Prediction</b>\n\n` +
                            `Round: ${this.lastBetEpoch}\n` +
                            `Direction: ${direction}\n` +
                            `Lock Price: $${lockPrice.toFixed(2)}\n` +
                            `Current Price: $${currentPrice.toFixed(2)}\n` +
                            `Price movement: ${priceDiff > 0 ? '+' : ''}$${priceDiff.toFixed(2)}\n` +
                            `Threshold: ±$${threshold}\n` +
                            `Assumption: LOSS ❌\n` +
                            `Real losses: ${this.earlyPrediction.realLosses.toFixed(4)} BNB\n` +
                            `Assumed losses: ${this.earlyPrediction.assumedLosses.toFixed(4)} BNB\n` +
                            `Next bet would be: ${nextBet.toFixed(4)} BNB (double #${nextBetDoubleLevel})\n\n` +
                            `🛑 <b>Stopping - ${reason}</b>`
                        );
                    }
                    
                    await this.stop(`Next bet would exceed maximum (${reason})`);
                    return null;
                }
            }
            
            // Store prediction details
            this.earlyPrediction.lastAssumedOutcome = assumedWin ? 'win' : 'loss';
            this.earlyPrediction.lastAssumedBet = betAmount;
            this.earlyPrediction.lastPredictionEpoch = this.lastBetEpoch;
            
            // If assuming WIN, track this round for later claim verification
            if (assumedWin) {
                this.earlyPrediction.pendingWinClaims.set(this.lastBetEpoch, betAmount);
                console.log(`📌 Tracking round ${this.lastBetEpoch} for win verification and claiming`);
            }
            
            console.log(
                `🔮 CONFIDENT PREDICTION - Price movement ($${Math.abs(priceDiff).toFixed(2)}) EXCEEDS threshold ($${threshold})\n` +
                `   Round ${this.lastBetEpoch} (${direction})\n` +
                `   Price diff: ${priceDiff > 0 ? '+' : ''}$${priceDiff.toFixed(2)}\n` +
                `   Assuming: ${assumedWin ? 'WIN ✅' : 'LOSS ❌'}\n` +
                `   Next bet: ${nextBet.toFixed(4)} BNB`
            );

            if (this.telegram) {
                await this.telegram.sendMessage(
                    `🔮 <b>Confident ${assumedWin ? 'WIN ✅' : 'LOSS ❌'} Prediction</b>\n\n` +
                    `Round: ${this.lastBetEpoch}\n` +
                    `Direction: ${direction}\n` +
                    `Lock Price: $${lockPrice.toFixed(2)}\n` +
                    `Current Price: $${currentPrice.toFixed(2)}\n` +
                    `Price movement: ${priceDiff > 0 ? '+' : ''}$${priceDiff.toFixed(2)}\n` +
                    `Threshold: ±$${threshold}\n` +
                    `Assumption: ${assumedWin ? 'WIN ✅' : 'LOSS ❌'}\n` +
                    `Real losses: ${this.earlyPrediction.realLosses.toFixed(4)} BNB\n` +
                    `Assumed losses: ${this.earlyPrediction.assumedLosses.toFixed(4)} BNB\n` +
                    `Next bet: ${nextBet.toFixed(4)} BNB`
                );
            }

            return {
                assumedWin,
                betAmount,
                nextBet,
                priceDiff,
                uncertain: false
            };
        } catch (error) {
            console.error('Early prediction error:', error);
            return null;
        }
    }

    async checkPreviousRoundResult() {
        try {
            if (!this.lastBetEpoch) return false;

            // Prevent checking the same round multiple times
            if (this.earlyPrediction.processedRounds.has(this.lastBetEpoch)) {
                console.log(`⏭️ Round ${this.lastBetEpoch} already processed, skipping`);
                return true; // Return true so betting continues
            }

            console.log(`🔍 Checking result for round ${this.lastBetEpoch}...`);

            const round = await this.contract.rounds(this.lastBetEpoch);
            const closePrice = Number(round[5]);
            
            if (closePrice === 0) {
                console.log(`⏳ Round ${this.lastBetEpoch} not closed yet (closePrice = 0)`);
                return false;
            }

            console.log(`✅ Round ${this.lastBetEpoch} closed! closePrice: ${closePrice}`);

            // Mark this round as processed to prevent duplicate checks
            this.earlyPrediction.processedRounds.add(this.lastBetEpoch);
            
            // Keep only the last 10 rounds to prevent memory growth
            if (this.earlyPrediction.processedRounds.size > 10) {
                const sorted = Array.from(this.earlyPrediction.processedRounds).sort((a, b) => a - b);
                this.earlyPrediction.processedRounds.delete(sorted[0]); // Remove oldest
            }

            const ledger = await this.contract.ledger(this.lastBetEpoch, this.wallet.address);
            const position = Number(ledger[0]);
            const lockPrice = Number(round[4]);
            const betAmount = parseFloat(ethers.formatEther(ledger[1]));
            const direction = position === 0 ? 'BULL' : 'BEAR';

            const priceWentUp = closePrice > lockPrice;
            const won = (position === 0 && priceWentUp) || (position === 1 && !priceWentUp);

            // EARLY PREDICTION MODE: Verify assumptions OR handle uncertain skip
            if (this.config.earlyPrediction && this.earlyPrediction.lastPredictionEpoch === this.lastBetEpoch) {
                const assumedWin = this.earlyPrediction.lastAssumedOutcome === 'win';
                const assumptionCorrect = assumedWin === won;
                
                console.log(`🔍 Verifying assumption: ${assumedWin ? 'WIN' : 'LOSS'} → Actually ${won ? 'WON' : 'LOST'} → ${assumptionCorrect ? 'CORRECT ✅' : 'WRONG ❌'}`);
                
                if (won) {
                    // We won - clear all losses (real and assumed)
                    this.earlyPrediction.realLosses = 0;
                    this.earlyPrediction.assumedLosses = 0;
                    
                    // Reset bet to base amount
                    this.state.currentBet = this.config.baseBetAmount;
                    
                    console.log(`🎉 WON! Round ${this.lastBetEpoch} - All losses cleared`);
                    
                    // Claim winnings
                    try {
                        const tx = await this.contract.claim([this.lastBetEpoch]);
                        await tx.wait();
                        console.log(`💰 Claimed winnings`);
                        
                        const newBalance = await this.provider.getBalance(this.wallet.address);
                        this.state.balance = ethers.formatEther(newBalance);
                        
                        if (this.telegram) {
                            await this.telegram.sendMessage(
                                `🎉 <b>Won Round ${this.lastBetEpoch}</b>\n\n` +
                                `Direction: ${direction}\n` +
                                `Bet: ${betAmount.toFixed(4)} BNB\n` +
                                `Assumption was: ${assumptionCorrect ? 'Correct ✅' : 'Wrong ❌'}\n` +
                                `All losses cleared!`
                            );
                        }
                    } catch (e) {
                        console.error('Claim error:', e.message);
                    }
                    
                    this.state.wins++;
                } else {
                    // We lost - convert assumed loss to real loss
                    if (assumptionCorrect) {
                        // We assumed loss and it was correct - loss was already in assumedLosses
                        this.earlyPrediction.realLosses += this.earlyPrediction.assumedLosses;
                        this.earlyPrediction.assumedLosses = 0;
                    } else {
                        // We assumed win but actually lost - add to real losses
                        this.earlyPrediction.realLosses += betAmount;
                        this.earlyPrediction.assumedLosses = 0;
                    }
                    
                    console.log(`❌ LOST! Round ${this.lastBetEpoch} - Real losses: ${this.earlyPrediction.realLosses.toFixed(4)} BNB`);
                    
                    if (this.telegram) {
                        await this.telegram.sendMessage(
                            `❌ <b>Lost Round ${this.lastBetEpoch}</b>\n\n` +
                            `Direction: ${direction}\n` +
                            `Bet: ${betAmount.toFixed(4)} BNB\n` +
                            `Assumption was: ${assumptionCorrect ? 'Correct ✅' : 'Wrong ❌'}\n` +
                            `Real losses: ${this.earlyPrediction.realLosses.toFixed(4)} BNB`
                        );
                    }
                    
                    this.state.losses++;
                }
                
                this.waitingForResults = false;
                this.state.totalBets++;
                
                // Clear prediction epoch since we've verified it
                this.earlyPrediction.lastPredictionEpoch = null;
                this.earlyPrediction.lastAssumedOutcome = null;
                return true;
            }
            
            // EARLY PREDICTION MODE - UNCERTAIN SKIP: No assumption was made, use real results
            if (this.config.earlyPrediction && this.earlyPrediction.skipNextRound) {
                console.log(`🔍 Verifying after uncertain skip: Round ${this.lastBetEpoch} → ${won ? 'WON' : 'LOST'}`);
                
                if (won) {
                    // We won - clear all losses
                    this.earlyPrediction.realLosses = 0;
                    this.earlyPrediction.assumedLosses = 0;
                    
                    // Reset bet to base amount
                    this.state.currentBet = this.config.baseBetAmount;
                    
                    console.log(`🎉 WON! Round ${this.lastBetEpoch} - All losses cleared`);
                    
                    // Claim winnings
                    try {
                        const tx = await this.contract.claim([this.lastBetEpoch]);
                        await tx.wait();
                        console.log(`💰 Claimed winnings`);
                        
                        const newBalance = await this.provider.getBalance(this.wallet.address);
                        this.state.balance = ethers.formatEther(newBalance);
                        
                        if (this.telegram) {
                            await this.telegram.sendMessage(
                                `🎉 <b>Won Round ${this.lastBetEpoch}</b>\n\n` +
                                `Direction: ${direction}\n` +
                                `Bet: ${betAmount.toFixed(4)} BNB\n` +
                                `(After uncertain skip - verified real result)\n` +
                                `All losses cleared!`
                            );
                        }
                    } catch (e) {
                        console.error('Claim error:', e.message);
                    }
                    
                    this.state.wins++;
                } else {
                    // We lost - add to real losses
                    this.earlyPrediction.realLosses += betAmount;
                    // Assumed losses should have been converted during skip, but keep them just in case
                    
                    // Calculate next bet to cover all losses
                    const totalLosses = this.earlyPrediction.realLosses + this.earlyPrediction.assumedLosses;
                    const nextBet = (totalLosses * 2).toFixed(6);
                    this.state.currentBet = nextBet;
                    
                    console.log(`❌ LOST! Round ${this.lastBetEpoch} - Real losses: ${this.earlyPrediction.realLosses.toFixed(4)} BNB, Assumed losses: ${this.earlyPrediction.assumedLosses.toFixed(4)} BNB`);
                    console.log(`📈 Next bet: ${nextBet} BNB (to cover ${totalLosses.toFixed(4)} BNB total losses)`);
                    
                    if (this.telegram) {
                        await this.telegram.sendMessage(
                            `❌ <b>Lost Round ${this.lastBetEpoch}</b>\n\n` +
                            `Direction: ${direction}\n` +
                            `Bet: ${betAmount.toFixed(4)} BNB\n` +
                            `(After uncertain skip - verified real result)\n` +
                            `Real losses: ${this.earlyPrediction.realLosses.toFixed(4)} BNB\n` +
                            `Assumed losses: ${this.earlyPrediction.assumedLosses.toFixed(4)} BNB\n` +
                            `Next bet: ${nextBet} BNB`
                        );
                    }
                    
                    this.state.losses++;
                }
                
                this.waitingForResults = false;
                this.state.totalBets++;
                
                // Results are now verified with REAL data, can resume normal betting
                // skipNextRound flag will be cleared in placeBet after this returns true
                return true;
            }
            
            // NORMAL MODE (no early prediction): Use standard Martingale logic
            if (won) {
                console.log(`🎉 WON! Round ${this.lastBetEpoch}`);
                
                this.waitingForResults = false;
                this.state.wins++;
                this.state.consecutiveLosses = 0;
                this.state.currentBet = this.config.baseBetAmount;
                this.state.totalLost = 0;

                // Claim winnings
                try {
                    const tx = await this.contract.claim([this.lastBetEpoch]);
                    await tx.wait();
                    console.log(`💰 Claimed winnings`);
                    
                    const newBalance = await this.provider.getBalance(this.wallet.address);
                    this.state.balance = ethers.formatEther(newBalance);
                    
                    if (this.telegram) {
                        await this.telegram.notifyWin(
                            this.lastBetEpoch,
                            direction,
                            betAmount,
                            'TBD'
                        );
                    }
                } catch (e) {
                    console.error('Claim error:', e.message);
                }
            } else {
                const newLosses = this.state.consecutiveLosses + 1;
                const newTotalLost = this.state.totalLost + betAmount;
                const nextBet = this.calculateNextBet(newLosses, newTotalLost);
                
                console.log(`❌ LOST! Round ${this.lastBetEpoch}`);
                
                this.waitingForResults = false;
                this.state.losses++;
                this.state.consecutiveLosses = newLosses;
                this.state.totalLost = newTotalLost;
                this.state.currentBet = nextBet;

                if (newLosses > this.config.maxDoubleDowns) {
                    console.log(`🛑 MAX LOSSES REACHED!`);
                    
                    if (this.telegram) {
                        await this.telegram.notifyLoss(
                            this.lastBetEpoch,
                            direction,
                            betAmount,
                            nextBet,
                            newLosses,
                            this.config.maxDoubleDowns + 1
                        );
                    }
                    
                    this.stop('Max loss streak reached');
                } else {
                    console.log(`📈 Doubling bet to ${nextBet} BNB (Lost ${newTotalLost.toFixed(6)} BNB total)`);
                    
                    if (this.telegram) {
                        await this.telegram.notifyLoss(
                            this.lastBetEpoch,
                            direction,
                            betAmount,
                            nextBet,
                            newLosses,
                            this.config.maxDoubleDowns + 1
                        );
                    }
                }
            }

            return true;
        } catch (error) {
            console.error('Error checking results:', error.message);
            return false;
        }
    }

    async placeBet() {
        try {
            console.log('🔄 placeBet() called - checking conditions...');
            
            const currentEpoch = await this.contract.currentEpoch();
            const epoch = Number(currentEpoch);

            console.log(`Current epoch: ${epoch}, Last bet: ${this.lastBetEpoch}, Waiting: ${this.waitingForResults}`);

            // EARLY PREDICTION FLOW
            if (this.config.earlyPrediction && this.waitingForResults && this.lastBetEpoch && this.lastBetEpoch <= epoch) {
                // Try to make early prediction (15-25 second window)
                const prediction = await this.tryEarlyPrediction();
                
                if (prediction && prediction.uncertain) {
                    // Price within safety envelope - DON'T bet on next round
                    // Let this round close, skip next round, then verify results
                    console.log(`⚠️ Uncertain prediction - will skip next round and verify results`);
                    this.waitingForResults = false; // Clear flag so we don't keep trying to predict
                    
                    // Mark that we need to verify results in the NEXT round (not bet)
                    this.earlyPrediction.skipNextRound = true;
                    return; // Don't bet this round
                    
                } else if (prediction && !prediction.uncertain) {
                    // Confident prediction - use the calculated next bet
                    console.log(`💭 Using confident prediction: ${prediction.nextBet.toFixed(4)} BNB - betting NOW on current epoch`);
                    this.waitingForResults = false;
                    this.state.currentBet = prediction.nextBet.toFixed(6);
                    this.earlyPrediction.shouldBetNow = true; // Flag to bypass timing check
                    
                    // Fall through to bet immediately on current epoch
                } else if (!prediction && this.lastBetEpoch < epoch) {
                    // Early prediction failed or timed out, and epoch moved forward
                    // Fall back to normal result checking
                    console.log(`⚠️ Early prediction not available (epoch ${this.lastBetEpoch}) - checking results normally`);
                    const resultsReady = await this.checkPreviousRoundResult();
                    if (!resultsReady) return;
                }
            }
            
            // SKIP ROUND AFTER UNCERTAIN PREDICTION
            if (this.config.earlyPrediction && this.earlyPrediction.skipNextRound) {
                // We're in the "skip round" - check if previous round is closed
                if (this.lastBetEpoch && this.lastBetEpoch < epoch) {
                    console.log(`🔍 Skip round active - verifying results from round ${this.lastBetEpoch}`);
                    
                    // FIRST: Verify any pending assumed outcomes from earlier rounds
                    if (this.earlyPrediction.lastPredictionEpoch && 
                        this.earlyPrediction.lastPredictionEpoch < this.lastBetEpoch) {
                        
                        const predictionEpoch = this.earlyPrediction.lastPredictionEpoch;
                        console.log(`🔍 Also verifying assumed outcome for round ${predictionEpoch}`);
                        
                        try {
                            const round = await this.contract.rounds(predictionEpoch);
                            const closePrice = Number(round[5]);
                            
                            if (closePrice > 0) {
                                const ledger = await this.contract.ledger(predictionEpoch, this.wallet.address);
                                const position = Number(ledger[0]);
                                const lockPrice = Number(round[4]);
                                const betAmt = parseFloat(ethers.formatEther(ledger[1]));
                                
                                const won = (position === 0 && closePrice > lockPrice) || 
                                           (position === 1 && closePrice < lockPrice);
                                
                                const assumedWin = this.earlyPrediction.lastAssumedOutcome === 'win';
                                
                                if (won) {
                                    // Actually won - clear assumed losses
                                    console.log(`✅ Round ${predictionEpoch} WON (assumption was ${assumedWin ? 'correct' : 'WRONG'})`);
                                    this.earlyPrediction.assumedLosses = 0;
                                    
                                    // Claim winnings
                                    try {
                                        const tx = await this.contract.claim([predictionEpoch]);
                                        await tx.wait();
                                        console.log(`💰 Claimed winnings from round ${predictionEpoch}`);
                                    } catch (e) {
                                        console.log(`Already claimed or error: ${e.message}`);
                                    }
                                } else {
                                    // Actually lost - convert assumed to real
                                    console.log(`❌ Round ${predictionEpoch} LOST (assumption was ${assumedWin ? 'WRONG' : 'correct'})`);
                                    this.earlyPrediction.realLosses += this.earlyPrediction.assumedLosses;
                                    this.earlyPrediction.assumedLosses = 0;
                                }
                                
                                // Clear the prediction tracking
                                this.earlyPrediction.lastPredictionEpoch = null;
                                this.earlyPrediction.lastAssumedOutcome = null;
                            }
                        } catch (e) {
                            console.error(`Error verifying round ${predictionEpoch}:`, e.message);
                        }
                    }
                    
                    // THEN: Check the current round result
                    const resultsReady = await this.checkPreviousRoundResult();
                    if (resultsReady) {
                        // Results verified - clear skip flag and continue normally next round
                        this.earlyPrediction.skipNextRound = false;
                    }
                }
                return; // Don't bet this round
            }

            // STANDARD FLOW: Wait for results (when NOT using early prediction)
            if (this.waitingForResults && this.lastBetEpoch && !this.config.earlyPrediction) {
                const resultsReady = await this.checkPreviousRoundResult();
                if (!resultsReady) return;
            }
            
            // VERIFY PREVIOUS ROUND: In early prediction, check if last round closed while betting on new one
            if (this.config.earlyPrediction && this.lastBetEpoch && this.lastBetEpoch < epoch - 1 && !this.earlyPrediction.skipNextRound) {
                // Only verify if we haven't already processed this round
                if (!this.earlyPrediction.processedRounds.has(this.lastBetEpoch)) {
                    // We're 2+ rounds ahead - check results of previous rounds asynchronously
                    console.log(`🔍 Verifying previous round ${this.lastBetEpoch} in background...`);
                    const oldLastBet = this.lastBetEpoch;
                    this.lastBetEpoch = epoch - 2; // Check the round before current
                    await this.checkPreviousRoundResult();
                    this.lastBetEpoch = oldLastBet; // Restore
                }
            }
            
            // VERIFY AND CLAIM PENDING ASSUMED WINS
            if (this.config.earlyPrediction && this.earlyPrediction.pendingWinClaims.size > 0) {
                for (const [roundEpoch, betAmt] of this.earlyPrediction.pendingWinClaims.entries()) {
                    // Only check rounds that are 2+ epochs old (should be closed by now)
                    if (roundEpoch < epoch - 1) {
                        try {
                            const round = await this.contract.rounds(roundEpoch);
                            const closePrice = Number(round[5]);
                            
                            if (closePrice > 0) {
                                // Round is closed, check if we actually won
                                const ledger = await this.contract.ledger(roundEpoch, this.wallet.address);
                                const position = Number(ledger[0]);
                                const lockPrice = Number(round[4]) / 1e8;
                                const closePriceUSD = closePrice / 1e8;
                                
                                const won = (position === 0 && closePriceUSD > lockPrice) || 
                                           (position === 1 && closePriceUSD < lockPrice);
                                
                                if (won) {
                                    // Assumption was correct! Claim winnings
                                    console.log(`✅ VERIFIED WIN - Round ${roundEpoch} (assumed win was correct!)`);
                                    
                                    try {
                                        const tx = await this.contract.claim([roundEpoch]);
                                        await tx.wait();
                                        console.log(`💰 Claimed winnings from round ${roundEpoch}`);
                                        
                                        // Clear losses ONLY if this was a Martingale recovery bet (not base bet)
                                        // Base bets might have been placed after newer losses were recorded
                                        const baseBet = parseFloat(this.config.baseBetAmount);
                                        const wasMartingaleBet = betAmt > baseBet + 0.001;
                                        
                                        if (wasMartingaleBet) {
                                            console.log(`🎉 Martingale recovery bet won - clearing REAL losses only`);
                                            this.earlyPrediction.realLosses = 0;
                                            // DON'T clear assumedLosses - they're from rounds that haven't closed yet
                                            // and weren't the reason for this Martingale bet
                                            
                                            // Recalculate current bet based on remaining assumed losses
                                            if (this.earlyPrediction.assumedLosses > 0) {
                                                this.state.currentBet = (this.earlyPrediction.assumedLosses * 2).toFixed(6);
                                                console.log(`Assumed losses remain: ${this.earlyPrediction.assumedLosses.toFixed(4)} BNB, next bet: ${this.state.currentBet} BNB`);
                                            } else {
                                                this.state.currentBet = this.config.baseBetAmount;
                                            }
                                        } else {
                                            console.log(`Base bet won - keeping current loss tracking intact`);
                                        }
                                        
                                        if (this.telegram) {
                                            let message = `✅ <b>Verified & Claimed Win</b>\n\n` +
                                                `Round: ${roundEpoch}\n` +
                                                `Bet: ${betAmt.toFixed(4)} BNB\n` +
                                                `Assumption was correct!\n`;
                                            
                                            if (wasMartingaleBet) {
                                                message += `Real losses cleared!\n`;
                                                if (this.earlyPrediction.assumedLosses > 0) {
                                                    message += `Assumed losses: ${this.earlyPrediction.assumedLosses.toFixed(4)} BNB (pending)\n`;
                                                    message += `Next bet: ${this.state.currentBet} BNB`;
                                                } else {
                                                    message += `All losses cleared!`;
                                                }
                                            } else {
                                                message += `Winnings claimed.`;
                                            }
                                            
                                            await this.telegram.sendMessage(message);
                                        }
                                    } catch (e) {
                                        console.error(`Claim error for round ${roundEpoch}:`, e.message);
                                    }
                                } else {
                                    // Assumption was WRONG - we actually lost
                                    console.log(`❌ VERIFIED LOSS - Round ${roundEpoch} (assumed win was WRONG!)`);
                                    this.earlyPrediction.realLosses += betAmt;
                                    
                                    // Recalculate the bet to cover the newly discovered losses
                                    const totalLosses = this.earlyPrediction.realLosses + this.earlyPrediction.assumedLosses;
                                    const correctedBet = (totalLosses * 2).toFixed(6);
                                    this.state.currentBet = correctedBet;
                                    
                                    console.log(`📈 Total losses now: ${totalLosses.toFixed(4)} BNB, next bet corrected to: ${correctedBet} BNB`);
                                    
                                    if (this.telegram) {
                                        await this.telegram.sendMessage(
                                            `❌ <b>Verified Loss</b>\n\n` +
                                            `Round: ${roundEpoch}\n` +
                                            `Assumed WIN but actually LOST\n` +
                                            `Bet: ${betAmt.toFixed(4)} BNB\n` +
                                            `Real losses: ${this.earlyPrediction.realLosses.toFixed(4)} BNB\n` +
                                            `Total losses: ${totalLosses.toFixed(4)} BNB\n` +
                                            `Next bet: ${correctedBet} BNB`
                                        );
                                    }
                                }
                                
                                // Remove from pending claims
                                this.earlyPrediction.pendingWinClaims.delete(roundEpoch);
                            }
                        } catch (e) {
                            console.error(`Error verifying round ${roundEpoch}:`, e.message);
                        }
                    }
                }
            }

            // Don't bet if already bet this round
            if (this.lastBetEpoch === epoch) {
                return;
            }

            // Don't bet if still waiting (shouldn't happen with early prediction)
            if (this.waitingForResults) {
                return;
            }

            const round = await this.contract.rounds(epoch);
            const lockTimestamp = Number(round[2]);
            const now = Math.floor(Date.now() / 1000);
            const timeUntilLock = lockTimestamp - now;

            // Allow betting if:
            // 1. Normal timing window (15-20s before lock), OR
            // 2. We just made a confident early prediction
            const inBettingWindow = (timeUntilLock <= BET_TIMING_SECONDS && timeUntilLock > 15) || 
                                     this.earlyPrediction.shouldBetNow;
            
            if (inBettingWindow) {
                // Clear the flag after checking
                if (this.earlyPrediction.shouldBetNow) {
                    console.log(`🎯 Betting immediately after confident prediction (bypassing timing check)`);
                    this.earlyPrediction.shouldBetNow = false;
                }
                
                // CHECK MAX BET LIMIT AND MAX DOUBLE-DOWNS (when early prediction is enabled)
                if (this.config.earlyPrediction) {
                    const maxBet = parseFloat(this.config.maxEarlyPredictionBet);
                    const maxDoubles = parseInt(this.config.maxDoubleDowns);
                    const currentBetFloat = parseFloat(this.state.currentBet);
                    const currentDoubleLevel = this.getDoubleDownLevel(currentBetFloat);
                    
                    const exceedsMaxBet = currentBetFloat > maxBet;
                    const exceedsMaxDoubles = currentDoubleLevel > maxDoubles;
                    
                    if (exceedsMaxBet || exceedsMaxDoubles) {
                        let reason;
                        if (exceedsMaxBet && exceedsMaxDoubles) {
                            reason = `exceeds max bet (${maxBet} BNB) and max double-downs (${maxDoubles})`;
                        } else if (exceedsMaxBet) {
                            reason = `exceeds max bet of ${maxBet} BNB`;
                        } else {
                            reason = `exceeds max double-downs of ${maxDoubles}`;
                        }
                        
                        console.log(`🛑 STOPPING: Current bet (${currentBetFloat.toFixed(4)} BNB, double #${currentDoubleLevel}) ${reason}`);
                        
                        if (this.telegram) {
                            await this.telegram.sendMessage(
                                `🛑 <b>Bot Stopped</b>\n\n` +
                                `Reason: ${reason}\n` +
                                `Current bet: ${currentBetFloat.toFixed(4)} BNB (double #${currentDoubleLevel})\n` +
                                `Max bet: ${maxBet} BNB\n` +
                                `Max double-downs: ${maxDoubles}\n` +
                                `Real losses: ${this.earlyPrediction.realLosses.toFixed(4)} BNB\n` +
                                `Assumed losses: ${this.earlyPrediction.assumedLosses.toFixed(4)} BNB`
                            );
                        }
                        
                        await this.stop(reason);
                        return;
                    }
                }
                
                // Determine direction based on config
                let direction;
                if (this.config.betDirection === 'BULL') {
                    direction = 'BULL';
                } else if (this.config.betDirection === 'BEAR') {
                    direction = 'BEAR';
                } else {
                    direction = Math.random() > 0.5 ? 'BULL' : 'BEAR';
                }
                
                const betAmount = ethers.parseEther(this.state.currentBet);

                console.log(`🎲 Betting ${this.state.currentBet} BNB on ${direction} - Round ${epoch}`);

                const balance = await this.provider.getBalance(this.wallet.address);
                if (balance < betAmount) {
                    console.error('❌ Insufficient balance!');
                    
                    if (this.telegram) {
                        await this.telegram.notifyLowBalance(
                            ethers.formatEther(balance),
                            this.state.currentBet
                        );
                    }
                    
                    this.stop('Insufficient balance');
                    return;
                }

                const tx = direction === 'BULL'
                    ? await this.contract.betBull(currentEpoch, { value: betAmount })
                    : await this.contract.betBear(currentEpoch, { value: betAmount });

                console.log(`📤 Transaction: ${tx.hash}`);
                
                await tx.wait();
                console.log(`✅ Bet placed!`);

                this.lastBetEpoch = epoch;
                
                // Only set waiting if we don't have an active prediction to verify
                if (!this.predictedEpoch) {
                    this.waitingForResults = true;
                }
                
                this.state.totalBets++;
                this.state.totalWagered += parseFloat(this.state.currentBet);

                const newBalance = await this.provider.getBalance(this.wallet.address);
                this.state.balance = ethers.formatEther(newBalance);

                if (this.telegram) {
                    await this.telegram.notifyBetPlaced(epoch, direction, this.state.currentBet);
                }
            }

        } catch (error) {
            console.error('Error placing bet:', error.message);
            
            if (this.telegram) {
                await this.telegram.notifyError(error.message);
            }
        }
    }

    async claimAllWinnings() {
        try {
            console.log('🔍 Scanning for unclaimed winnings...');
            
            // Use getUserRounds() - the same contract function the PancakeSwap
            // frontend uses. It returns ONLY the rounds you actually participated in,
            // so we don't have to scan the blockchain round-by-round.
            const userAddress = this.wallet.address;
            const allEpochs = [];
            
            // Paginate through getUserRounds (contract returns them newest-first).
            // We grab up to 1000 at a time until we've collected the user's rounds.
            let cursor = 0;
            const PAGE_SIZE = 1000;
            const MAX_PAGES = 5; // up to 5000 rounds of history
            
            for (let page = 0; page < MAX_PAGES; page++) {
                try {
                    const result = await this.contract.getUserRounds(userAddress, cursor, PAGE_SIZE);
                    const epochs = result[0]; // uint256[] of epochs
                    // result[1] is BetInfo[] (position, amount, claimed) - we don't need it here
                    const nextCursor = result[2];
                    
                    if (epochs.length === 0) break;
                    
                    for (const e of epochs) {
                        allEpochs.push(Number(e));
                    }
                    
                    // If we got fewer than a full page, we've reached the end
                    if (epochs.length < PAGE_SIZE) break;
                    
                    cursor = Number(nextCursor);
                } catch (e) {
                    console.error(`Error fetching user rounds page ${page}: ${e.message}`);
                    break;
                }
            }
            
            if (allEpochs.length === 0) {
                return `✅ <b>No Rounds Found</b>\n\n` +
                       `You haven't participated in any prediction rounds with this wallet.`;
            }
            
            console.log(`Found ${allEpochs.length} rounds you participated in. Checking which are claimable...`);
            
            // Now check which of YOUR rounds are actually claimable (won + unclaimed).
            // This only checks rounds you bet on, not every round on the blockchain.
            const claimableEpochs = [];
            
            for (const epoch of allEpochs) {
                try {
                    const isClaimable = await this.contract.claimable(epoch, userAddress);
                    if (isClaimable) {
                        claimableEpochs.push(epoch);
                        console.log(`  ✅ Round ${epoch} is claimable`);
                    }
                } catch (e) {
                    continue;
                }
            }
            
            if (claimableEpochs.length === 0) {
                return `✅ <b>No Unclaimed Winnings</b>\n\n` +
                       `Checked all ${allEpochs.length} rounds you played.\n` +
                       `Everything is already claimed!`;
            }
            
            console.log(`Found ${claimableEpochs.length} claimable rounds, claiming in one transaction...`);
            
            // Record balance before claiming to calculate actual winnings
            const balanceBefore = await this.provider.getBalance(userAddress);
            
            // Claim ALL winning rounds in a SINGLE transaction - exactly like the
            // frontend's "Collect Winnings" button. One gas fee for everything.
            // We only batch if there are more than 100 (to stay under block gas limit).
            const BATCH_SIZE = 100;
            let claimedCount = 0;
            const failedBatches = [];
            
            for (let i = 0; i < claimableEpochs.length; i += BATCH_SIZE) {
                const batch = claimableEpochs.slice(i, i + BATCH_SIZE);
                try {
                    console.log(`Claiming ${batch.length} rounds in one transaction...`);
                    const tx = await this.contract.claim(batch);
                    await tx.wait();
                    claimedCount += batch.length;
                    console.log(`✅ Claimed: ${batch.join(', ')}`);
                } catch (e) {
                    console.error(`❌ Failed to claim batch: ${e.message}`);
                    failedBatches.push(batch);
                }
            }
            
            // Calculate actual winnings received
            const balanceAfter = await this.provider.getBalance(userAddress);
            const netReceived = parseFloat(ethers.formatEther(balanceAfter - balanceBefore));
            this.state.balance = ethers.formatEther(balanceAfter);
            
            const txCount = Math.ceil(claimableEpochs.length / BATCH_SIZE);
            
            let message = `💰 <b>Claim Complete</b>\n\n`;
            message += `Rounds claimed: ${claimedCount}/${claimableEpochs.length}\n`;
            message += `Transactions used: ${txCount - failedBatches.length}\n`;
            message += `Net received: ${netReceived.toFixed(6)} BNB (after gas)\n\n`;
            message += `New balance: ${this.state.balance} BNB`;
            
            if (failedBatches.length > 0) {
                const failedCount = failedBatches.reduce((sum, b) => sum + b.length, 0);
                message += `\n\n⚠️ ${failedCount} rounds failed. Try /claim again.`;
            }
            
            return message;
            
        } catch (error) {
            console.error('Error claiming winnings:', error.message);
            return `❌ <b>Claim Error</b>\n\n${error.message}`;
        }
    }

    async start() {
        if (this.isRunning) {
            console.log('Bot already running');
            return;
        }

        this.isRunning = true;
        console.log('🤖 Bot started!');
        
        // Clear any stale waiting state from previous session
        if (this.waitingForResults && this.lastBetEpoch) {
            console.log(`Checking for stale results from round ${this.lastBetEpoch}...`);
            const currentEpoch = await this.contract.currentEpoch();
            
            // If the epoch we were waiting on is more than 2 rounds old, just clear it
            if (Number(currentEpoch) - this.lastBetEpoch > 2) {
                console.log(`Round ${this.lastBetEpoch} is too old, clearing waiting state`);
                this.waitingForResults = false;
            } else {
                // Try to check the result
                await this.checkPreviousRoundResult();
            }
        }

        if (this.telegram) {
            await this.telegram.notifyBotStarted(this.config);
        }

        // Main loop
        while (this.isRunning) {
            try {
                await this.placeBet();
            } catch (error) {
                console.error('Error in main loop:', error.message);
                if (this.telegram) {
                    await this.telegram.notifyError(`Loop error: ${error.message}`);
                }
            }
            
            await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL));
        }
    }

    stop(reason = 'Manual stop') {
        if (!this.isRunning) return;
        
        this.isRunning = false;
        console.log(`🛑 Bot stopped: ${reason}`);

        if (this.telegram) {
            // Build stop message with streak info
            let message = `🛑 <b>BOT STOPPED</b>\n\nReason: ${reason}`;
            
            if (this.state.consecutiveLosses > 0) {
                message += `\n\n<b>Current Streak:</b>`;
                message += `\n• Losses: ${this.state.consecutiveLosses}`;
                message += `\n• Total Lost: ${this.state.totalLost.toFixed(6)} BNB`;
                message += `\n• Next Bet: ${this.state.currentBet} BNB`;
                message += `\n\n<b>Commands:</b>`;
                message += `\n/reset - Reset to base bet (${this.config.baseBetAmount} BNB)`;
                message += `\n/continue - Keep current streak`;
                message += `\n/start - Resume trading`;
            }
            
            this.telegram.sendMessage(message);
        }
    }

    reset() {
        console.log('🔄 Resetting bet sequence to base');
        
        const oldLosses = this.state.consecutiveLosses;
        const oldTotalLost = this.state.totalLost;
        
        this.state.consecutiveLosses = 0;
        this.state.totalLost = 0;
        this.state.currentBet = this.config.baseBetAmount;
        
        // Clear waiting state to avoid processing old rounds
        this.waitingForResults = false;
        this.lastBetEpoch = null;
        
        // Reset early prediction state
        this.earlyPrediction.realLosses = 0;
        this.earlyPrediction.assumedLosses = 0;
        this.earlyPrediction.lastAssumedOutcome = null;
        this.earlyPrediction.lastAssumedBet = 0;
        this.earlyPrediction.lastPredictionEpoch = null;
        this.earlyPrediction.skipNextRound = false;
        this.earlyPrediction.pendingWinClaims.clear();
        this.earlyPrediction.processedRounds.clear();
        
        if (this.telegram && oldLosses > 0) {
            this.telegram.sendMessage(
                `🔄 <b>Sequence Reset</b>\n\n` +
                `Previous streak cleared:\n` +
                `• ${oldLosses} losses\n` +
                `• ${oldTotalLost.toFixed(6)} BNB lost\n\n` +
                `Next bet will be: ${this.config.baseBetAmount} BNB`
            );
        }
    }

    async shutdown() {
        this.stop('Shutdown');
        if (this.telegramController) {
            this.telegramController.stop();
        }
    }
}

// Main execution
async function main() {
    const config = {
        privateKey: process.env.PRIVATE_KEY,
        rpcUrl: process.env.RPC_URL || 'https://bsc-dataseed.binance.org/',
        baseBetAmount: process.env.BASE_BET_AMOUNT || '0.02',
        maxDoubleDowns: parseInt(process.env.MAX_DOUBLE_DOWNS || '3'),
        betDirection: process.env.BET_DIRECTION || 'RANDOM', // BULL, BEAR, or RANDOM
        earlyPrediction: process.env.EARLY_PREDICTION !== 'false', // Default ON
        predictionThreshold: process.env.PREDICTION_THRESHOLD || '0.20',
        maxEarlyPredictionBet: process.env.MAX_EARLY_PREDICTION_BET || '0.36',
        telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
        telegramChatId: process.env.TELEGRAM_CHAT_ID
    };

    // Validate required env vars
    if (!config.privateKey) {
        throw new Error('PRIVATE_KEY environment variable required');
    }

    const bot = new PancakePredictionBot(config);

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        console.log('\n🛑 Shutting down...');
        await bot.shutdown();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        console.log('\n🛑 Shutting down...');
        await bot.shutdown();
        process.exit(0);
    });

    try {
        await bot.initialize();
        
        // Auto-start if configured
        if (process.env.AUTO_START === 'true') {
            await bot.start();
        } else {
            console.log('⏸️  Bot initialized but not started. Use /start command in Telegram.');
        }
    } catch (error) {
        console.error('❌ Fatal error:', error.message);
        process.exit(1);
    }
}

main();
