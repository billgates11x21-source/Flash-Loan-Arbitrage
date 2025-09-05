const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// Base network configuration
const BASE_RPC_URL = "https://mainnet.base.org";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "0xd46c12869e0e964d117b67f39deb8c2a8359aaede080162ab0c0acefb234f5e8";
const DEXSCREENER_API_BASE = "https://api.dexscreener.com";

// Contract configuration
let contractAddress = process.env.CONTRACT_ADDRESS || "0x8dc3d3eeca945f83772f746610aA7FB4b86a1e82";
let contractABI = null;
let provider = null;
let wallet = null;
let contract = null;

// Load contract ABI
try {
  const contractArtifact = require('../artifacts/contracts/BaseFlashLoanArbitrage.sol/BaseFlashLoanArbitrage.json');
  contractABI = contractArtifact.abi;
} catch (error) {
  console.log("Contract artifact not found, deploy contract first");
}

// Initialize blockchain connection
async function initializeBlockchain() {
  try {
    provider = new ethers.providers.JsonRpcProvider(BASE_RPC_URL);
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);

    console.log("Wallet address:", wallet.address);
    const balance = await wallet.getBalance();
    console.log("Wallet balance:", ethers.utils.formatEther(balance), "ETH");

    // Initialize contract if address and ABI are available
    if (contractAddress && contractABI) {
      contract = new ethers.Contract(contractAddress, contractABI, wallet);
      console.log("Contract initialized at:", contractAddress);
    }

    return true;
  } catch (error) {
    console.error("Failed to initialize blockchain:", error);
    return false;
  }
}

// DexScreener API functions
async function getBaseTokenPairs(tokenAddress) {
  try {
    const response = await fetch(`${DEXSCREENER_API_BASE}/latest/dex/tokens/${tokenAddress}`);
    const data = await response.json();

    // Filter for Base network pairs
    const basePairs = data.pairs?.filter(pair => pair.chainId === 'base') || [];
    return basePairs;
  } catch (error) {
    console.error("Error fetching token pairs:", error);
    return [];
  }
}

async function findArbitrageOpportunities() {
  try {
    // Key tokens on Base to monitor
    const tokensToMonitor = [
      "0x4200000000000000000000000000000000000006", // WETH
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
      "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", // USDbC
    ];

    const opportunities = [];

    for (const token of tokensToMonitor) {
      const pairs = await getBaseTokenPairs(token);

      // Analyze pairs for arbitrage opportunities
      for (let i = 0; i < pairs.length; i++) {
        for (let j = i + 1; j < pairs.length; j++) {
          const pair1 = pairs[i];
          const pair2 = pairs[j];

          // Check if pairs share the same quote token
            if (pair1.quoteToken.address === pair2.quoteToken.address) {
              const price1 = parseFloat(pair1.priceUsd);
              const price2 = parseFloat(pair2.priceUsd);

              // Skip if prices are invalid or too extreme
              if (!price1 || !price2 || price1 <= 0 || price2 <= 0 ||
                  price1 > 1000000 || price2 > 1000000 ||
                  price1 < 0.000001 || price2 < 0.000001) {
                continue;
              }

              const priceDiff = Math.abs(price1 - price2);
              const avgPrice = (price1 + price2) / 2;
              const priceDiffPercent = (priceDiff / avgPrice) * 100;

              // Require minimum liquidity and reasonable price difference
              const minLiquidity = 100; // $100 minimum (reduced for more opportunities)
              if (priceDiffPercent > 1.0 && priceDiffPercent < 10 && // More conservative range
                  pair1.liquidity?.usd > minLiquidity && 
                  pair2.liquidity?.usd > minLiquidity &&
                  price1 > 0.0001 && price2 > 0.0001 && // More reasonable minimum prices
                  price1 < 100000 && price2 < 100000 && // More reasonable maximum prices
                  Math.abs(Math.log10(price1/price2)) < 2) { // Ensure prices aren't too far apart (max 100x difference)
                opportunities.push({
                  tokenIn: pair1.baseToken.address,
                  tokenOut: pair1.quoteToken.address,
                  dex1: pair1.dexId,
                  dex2: pair2.dexId,
                  price1: pair1.priceUsd,
                  price2: pair2.priceUsd,
                  priceDiff: priceDiffPercent,
                  liquidity1: pair1.liquidity?.usd || 0,
                  liquidity2: pair2.liquidity?.usd || 0,
                  volume24h1: pair1.volume?.h24 || 0,
                  volume24h2: pair2.volume?.h24 || 0,
                  timestamp: Date.now()
                });
              }
            }
        }
      }
    }

    // Sort by price difference (highest first)
    opportunities.sort((a, b) => b.priceDiff - a.priceDiff);

    return opportunities.slice(0, 10); // Return top 10 opportunities
  } catch (error) {
    console.error("Error finding arbitrage opportunities:", error);
    return [];
  }
}

// Gas optimization
async function getOptimalGasPrice() {
  try {
    const gasPrice = await provider.getGasPrice();
    // Use current gas price without buffer to save on gas
    return gasPrice;
  } catch (error) {
    console.error("Error getting gas price:", error);
    return ethers.utils.parseUnits("0.5", "gwei"); // Lower fallback
  }
}

// Execute arbitrage
async function executeArbitrage(opportunity) {
  try {
    if (!contract) {
      throw new Error("Contract not deployed or initialized");
    }

    // Check wallet balance for gas
    const balance = await wallet.getBalance();
    const minBalance = ethers.utils.parseEther("0.0005"); // 0.0005 ETH minimum (reduced)
    
    if (balance.lt(minBalance)) {
      throw new Error(`Insufficient ETH balance for gas. Current: ${ethers.utils.formatEther(balance)} ETH. Need at least 0.0005 ETH.`);
    }

    console.log(`💰 Wallet balance: ${ethers.utils.formatEther(balance)} ETH`);

    // Calculate optimal loan amount based on liquidity
    const minLiquidity = Math.min(opportunity.liquidity1, opportunity.liquidity2);
    
    // Use a safe fixed amount to avoid decimal parsing issues
    let loanAmount;
    
    try {
      // Use a reasonable fixed amount based on liquidity
      if (minLiquidity >= 1000) {
        loanAmount = ethers.utils.parseEther("0.01"); // 0.01 ETH for good liquidity
      } else if (minLiquidity >= 100) {
        loanAmount = ethers.utils.parseEther("0.001"); // 0.001 ETH for medium liquidity
      } else {
        loanAmount = ethers.utils.parseEther("0.0001"); // 0.0001 ETH for low liquidity
      }
    } catch (error) {
      // Fallback to smallest safe amount
      loanAmount = ethers.utils.parseEther("0.0001");
      console.log("Using fallback loan amount:", ethers.utils.formatEther(loanAmount));
    }

    // Prepare arbitrage parameters as array (not object)
    const arbParams = [
      opportunity.tokenIn,
      opportunity.tokenOut,
      loanAmount,
      3000, // fee1: 0.3% fee
      500,  // fee2: 0.05% fee
      opportunity.dex1 === 'aerodrome' || opportunity.dex2 === 'aerodrome' // useAerodrome
    ];

    // Encode parameters correctly as tuple
    const encodedParams = ethers.utils.defaultAbiCoder.encode(
      ['tuple(address,address,uint256,uint24,uint24,bool)'],
      [arbParams]
    );

    // Get optimal gas price
    const gasPrice = await getOptimalGasPrice();

    // Execute flash loan arbitrage with reduced gas limit
    const tx = await contract.executeFlashLoanArbitrage(
      opportunity.tokenIn,
      loanAmount,
      encodedParams,
      {
        gasPrice: gasPrice,
        gasLimit: 300000 // Reduced gas limit
      }
    );

    console.log("Arbitrage transaction sent:", tx.hash);

    // Wait for confirmation
    const receipt = await tx.wait();
    console.log("Arbitrage executed successfully:", receipt.transactionHash);

    return {
      success: true,
      txHash: receipt.transactionHash,
      gasUsed: receipt.gasUsed.toString(),
      opportunity: opportunity
    };

  } catch (error) {
    console.error("Error executing arbitrage:", error);
    return {
      success: false,
      error: error.message,
      opportunity: opportunity
    };
  }
}

// Continuous monitoring and execution
let isMonitoring = false;

async function startArbitrageBot() {
  if (isMonitoring) {
    console.log("Bot already running");
    return;
  }

  isMonitoring = true;
  console.log("Starting arbitrage bot...");

  while (isMonitoring) {
    try {
      console.log("Scanning for arbitrage opportunities...");

      const opportunities = await findArbitrageOpportunities();

      if (opportunities.length > 0) {
        console.log(`Found ${opportunities.length} opportunities`);

        // Execute the most profitable opportunity
        const bestOpportunity = opportunities[0];

        if (bestOpportunity.priceDiff > 1.0) { // Only execute if >1% profit potential
          console.log(`🚀 EXECUTING ARBITRAGE:`);
          console.log(`   Token: ${bestOpportunity.tokenIn} -> ${bestOpportunity.tokenOut}`);
          console.log(`   Price Diff: ${bestOpportunity.priceDiff.toFixed(2)}%`);
          console.log(`   DEX1: ${bestOpportunity.dex1}, DEX2: ${bestOpportunity.dex2}`);
          console.log(`   Liquidity: $${bestOpportunity.liquidity1.toFixed(0)} / $${bestOpportunity.liquidity2.toFixed(0)}`);
          
          const result = await executeArbitrage(bestOpportunity);

          if (result.success) {
            console.log(`✅ ARBITRAGE SUCCESS! TX: ${result.txHash}`);
            console.log(`   Gas Used: ${result.gasUsed}`);
          } else {
            console.log(`❌ ARBITRAGE FAILED: ${result.error}`);
          }
        } else {
          console.log(`⏭️  Skipping opportunity: ${bestOpportunity.priceDiff.toFixed(2)}% profit too low`);
        }
      } else {
        console.log("No profitable opportunities found");
      }

      // Wait 30 seconds before next scan
      await new Promise(resolve => setTimeout(resolve, 30000));

    } catch (error) {
      console.error("Error in arbitrage bot:", error);
      await new Promise(resolve => setTimeout(resolve, 60000)); // Wait 1 minute on error
    }
  }
}

function stopArbitrageBot() {
  isMonitoring = false;
  console.log("Arbitrage bot stopped");
}

// API Endpoints
app.get('/api/opportunities', async (req, res) => {
  try {
    const opportunities = await findArbitrageOpportunities();
    res.json({ opportunities });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/deploy', async (req, res) => {
  try {
    console.log("Deploying BaseFlashLoanArbitrage contract to Base network...");

    const AAVE_POOL_ADDRESSES_PROVIDER = "0xe20fcbdbffc4dd138ce8b2e6fbb6cb49777ad64d";

    if (!contractABI) {
      return res.status(400).json({ 
        success: false, 
        error: "Contract ABI not found. Please compile contracts first." 
      });
    }

    // Load bytecode
    const contractArtifact = require('../artifacts/contracts/BaseFlashLoanArbitrage.sol/BaseFlashLoanArbitrage.json');
    const contractBytecode = contractArtifact.bytecode;

    const factory = new ethers.ContractFactory(contractABI, contractBytecode, wallet);

    // Deploy contract
    const deployedContract = await factory.deploy(AAVE_POOL_ADDRESSES_PROVIDER);
    await deployedContract.deployed();

    contractAddress = deployedContract.address;
    contract = deployedContract;

    console.log(`BaseFlashLoanArbitrage deployed to: ${contractAddress}`);

    res.json({ 
      success: true, 
      contractAddress: contractAddress 
    });
  } catch (error) {
    console.error("Deployment error:", error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.post('/api/start-bot', async (req, res) => {
  try {
    if (!contract) {
      return res.status(400).json({ error: "Contract not deployed or initialized" });
    }

    startArbitrageBot();
    res.json({ success: true, message: "Arbitrage bot started" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/stop-bot', (req, res) => {
  stopArbitrageBot();
  res.json({ success: true, message: "Arbitrage bot stopped" });
});

app.get('/api/status', async (req, res) => {
  try {
    const balance = wallet ? await wallet.getBalance() : 0;

    res.json({
      walletAddress: wallet?.address,
      balance: balance ? ethers.utils.formatEther(balance) : "0",
      contractAddress,
      contractDeployed: !!contract,
      botRunning: isMonitoring,
      network: "Base Mainnet"
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve static files
app.use(express.static('client'));

// Initialize and start server
async function startServer() {
  const initialized = await initializeBlockchain();

  if (!initialized) {
    console.error("Failed to initialize blockchain connection");
    process.exit(1);
  }

  const PORT = process.env.PORT || 3001;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Arbitrage backend running on port ${PORT}`);
    console.log(`Dashboard: http://localhost:${PORT}`);
  });
}

startServer();