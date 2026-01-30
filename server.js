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
        
        this.predictedResult = null;
        this.predictedBet = null;
        this.predictedLosses = null;
        this.predictedTotalLost = null;
    }

    async getCurrentBNBPrice() {
        try {
            const response = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT');
            const data = await response.json();
            return parseFloat(data.price);
        } catch (error) {
            console.error('Error fetching BNB price:', error);
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
            return '🤖 Bot started!';
        });

        this.telegramController.onStop(async () => {
            if (!this.isRunning) {
                return '⚠️ Bot is not running!';
            }
            this.stop('Manual stop via Telegram');
            return '🛑 Bot stopped!';
        });

        this.telegramController.onStatus(async () => {
            const status = this.isRunning ? '🟢 RUNNING' : '🔴 STOPPED';
            const waiting = this.waitingForResults ? '⏳ Waiting for results...' : '✅ Ready to bet';
            
            return `<b>BOT STATUS</b>\n\n` +
                   `Status: ${status}\n` +
                   `State: ${waiting}\n` +
                   `Balance: ${this.state.balance} BNB\n` +
                   `Next Bet: ${this.state.currentBet} BNB\n` +
                   `Loss Streak: ${this.state.consecutiveLosses}/${this.config.maxDoubleDowns}`;
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
            const closeTimestamp = Number(round[3]);
            const lockPrice = Number(round[4]) / 1e8;
            
            const now = Math.floor(Date.now() / 1000);
            const timeUntilClose = closeTimestamp - now;

            if (timeUntilClose > 25 || timeUntilClose < 15) {
                return null;
            }

            const currentPrice = await this.getCurrentBNBPrice();
            if (!currentPrice) return null;

            const priceDiff = currentPrice - lockPrice;
            const threshold = parseFloat(this.config.predictionThreshold);
            
            if (Math.abs(priceDiff) < threshold) {
                return null;
            }

            const ledger = await this.contract.ledger(this.lastBetEpoch, this.wallet.address);
            const position = Number(ledger[0]);
            const betAmount = ethers.formatEther(ledger[1]);
            
            const priceWentUp = priceDiff > 0;
            const predictedWin = (position === 0 && priceWentUp) || (position === 1 && !priceWentUp);
            
            const direction = position === 0 ? 'BULL' : 'BEAR';
            
            console.log(
                `🔮 EARLY PREDICTION: Round ${this.lastBetEpoch} (${direction}) - ` +
                `Price ${priceDiff > 0 ? '+' : ''}$${priceDiff.toFixed(2)} - ` +
                `Predicting ${predictedWin ? 'WIN' : 'LOSS'}`
            );

            if (this.telegram) {
                await this.telegram.sendMessage(
                    `🔮 <b>Early Prediction</b>\n\n` +
                    `Round: ${this.lastBetEpoch}\n` +
                    `Direction: ${direction}\n` +
                    `Price movement: ${priceDiff > 0 ? '+' : ''}$${priceDiff.toFixed(2)}\n` +
                    `Prediction: ${predictedWin ? 'WIN ✅' : 'LOSS ❌'}`
                );
            }

            return {
                predictedWin,
                betAmount: parseFloat(betAmount),
                priceDiff
            };
        } catch (error) {
            console.error('Early prediction error:', error);
            return null;
        }
    }

    async checkPreviousRoundResult() {
        try {
            if (!this.lastBetEpoch) return false;

            const round = await this.contract.rounds(this.lastBetEpoch);
            const closePrice = Number(round[5]);
            
            if (closePrice === 0) return false;

            const ledger = await this.contract.ledger(this.lastBetEpoch, this.wallet.address);
            const position = Number(ledger[0]);
            const lockPrice = Number(round[4]);
            const betAmount = ethers.formatEther(ledger[1]);
            const direction = position === 0 ? 'BULL' : 'BEAR';

            const priceWentUp = closePrice > lockPrice;
            const won = (position === 0 && priceWentUp) || (position === 1 && !priceWentUp);

            // Check prediction if we made one
            let predictionWasHandled = false;
            if (this.predictedResult) {
                predictionWasHandled = true;
                const predictedWon = this.predictedResult === 'win';
                const predictionCorrect = predictedWon === won;
                
                if (predictionCorrect) {
                    console.log(`✅ Early prediction was CORRECT!`);
                    predictionWasHandled = false;
                } else {
                    console.log(`❌ Early prediction was WRONG! Applying corrections...`);
                    
                    const actualBetAmount = parseFloat(betAmount);
                    
                    if (predictedWon && !won) {
                        const actualNewLosses = this.state.consecutiveLosses + 1;
                        const actualNewTotalLost = this.state.totalLost + actualBetAmount;
                        const actualNextBet = this.calculateNextBet(actualNewLosses, actualNewTotalLost);
                        
                        console.log(`🔧 Correction applied. Total lost: ${actualNewTotalLost.toFixed(6)} BNB`);
                        
                        this.state.consecutiveLosses = actualNewLosses;
                        this.state.totalLost = actualNewTotalLost;
                        this.state.currentBet = actualNextBet;
                        this.state.losses++;
                        
                        if (this.telegram) {
                            await this.telegram.sendMessage(
                                `⚠️ <b>Prediction Correction</b>\n\n` +
                                `Predicted WIN but actually LOST\n` +
                                `Adjusting bet amounts...\n` +
                                `Next bet: ${actualNextBet} BNB`
                            );
                        }
                    } else if (!predictedWon && won) {
                        console.log(`🎉 Bonus! Predicted loss but WON with larger bet!`);
                        
                        this.state.consecutiveLosses = 0;
                        this.state.totalLost = 0;
                        this.state.currentBet = this.config.baseBetAmount;
                        this.state.wins++;
                    }
                }
                
                this.predictedResult = null;
                this.predictedBet = null;
                this.predictedLosses = null;
                this.predictedTotalLost = null;
            }

            if (won && !predictionWasHandled) {
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
                            'TBD' // Calculate actual winnings if needed
                        );
                    }
                } catch (e) {
                    console.error('Claim error:', e.message);
                }
            } else if (!predictionWasHandled) {
                const actualBetAmount = parseFloat(betAmount);
                const newLosses = this.state.consecutiveLosses + 1;
                const newTotalLost = this.state.totalLost + actualBetAmount;
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
                            this.config.maxDoubleDowns
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
                            this.config.maxDoubleDowns
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
            const currentEpoch = await this.contract.currentEpoch();
            const epoch = Number(currentEpoch);

            // EARLY PREDICTION FLOW
            if (this.config.earlyPrediction && this.waitingForResults && this.lastBetEpoch && this.lastBetEpoch < epoch - 1) {
                // The round we bet on is old enough that we can try predicting
                const prediction = await this.tryEarlyPrediction();
                
                if (prediction && !this.predictedResult) {
                    // Store prediction
                    this.predictedResult = prediction.predictedWin ? 'win' : 'loss';
                    
                    // Calculate next bet based on prediction
                    let predictedNextBet;
                    
                    if (prediction.predictedWin) {
                        predictedNextBet = this.config.baseBetAmount;
                        this.predictedLosses = 0;
                        this.predictedTotalLost = 0;
                    } else {
                        const predictedLosses = this.state.consecutiveLosses + 1;
                        const predictedTotalLost = this.state.totalLost + prediction.betAmount;
                        predictedNextBet = this.calculateNextBet(predictedLosses, predictedTotalLost);
                        this.predictedLosses = predictedLosses;
                        this.predictedTotalLost = predictedTotalLost;
                    }
                    
                    this.predictedBet = parseFloat(predictedNextBet);
                    this.state.currentBet = predictedNextBet;
                    
                    console.log(
                        `💭 Early prediction made! Next bet: ${predictedNextBet} BNB (will verify when round ${this.lastBetEpoch} closes)`
                    );
                    
                    // CRITICALLY: Clear waiting flag so we can bet NOW
                    this.waitingForResults = false;
                    
                    // Fall through to bet immediately on current round
                }
            }

            // STANDARD FLOW: Wait for results (when NOT using early prediction)
            if (this.waitingForResults && this.lastBetEpoch && !this.config.earlyPrediction) {
                const resultsReady = await this.checkPreviousRoundResult();
                if (!resultsReady) return;
            }

            // VERIFY PREDICTION: Check if old prediction was right (async from betting)
            if (this.predictedResult && this.lastBetEpoch && this.lastBetEpoch < epoch) {
                // Check the result of the round we predicted on
                await this.checkPreviousRoundResult();
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

            if (timeUntilLock <= BET_TIMING_SECONDS && timeUntilLock > 15) {
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
                this.waitingForResults = true;
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

    async start() {
        if (this.isRunning) {
            console.log('Bot already running');
            return;
        }

        this.isRunning = true;
        console.log('🤖 Bot started!');

        if (this.telegram) {
            await this.telegram.notifyBotStarted(this.config);
        }

        // Main loop
        while (this.isRunning) {
            await this.placeBet();
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
        baseBetAmount: process.env.BASE_BET_AMOUNT || '0.003',
        maxDoubleDowns: parseInt(process.env.MAX_DOUBLE_DOWNS || '7'),
        betDirection: process.env.BET_DIRECTION || 'RANDOM', // BULL, BEAR, or RANDOM
        earlyPrediction: process.env.EARLY_PREDICTION === 'true',
        predictionThreshold: process.env.PREDICTION_THRESHOLD || '0.20',
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
