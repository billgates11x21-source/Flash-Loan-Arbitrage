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
let contractAddress = process.env.CONTRACT_ADDRESS || null;
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
              const minLiquidity = 1000; // $1000 minimum
              if (priceDiffPercent > 2.0 && priceDiffPercent < 50 && 
                  pair1.liquidity?.usd > minLiquidity && 
                  pair2.liquidity?.usd > minLiquidity) {
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
    // Add 10% buffer for faster execution
    const optimizedGasPrice = gasPrice.mul(110).div(100);
    return optimizedGasPrice;
  } catch (error) {
    console.error("Error getting gas price:", error);
    return ethers.utils.parseUnits("1", "gwei"); // Fallback
  }
}

// Execute arbitrage
async function executeArbitrage(opportunity) {
  try {
    if (!contract) {
      throw new Error("Contract not deployed or initialized");
    }

    // Calculate optimal loan amount based on liquidity
    const minLiquidity = Math.min(opportunity.liquidity1, opportunity.liquidity2);
    const maxLoanAmount = minLiquidity * 0.1; // Use 10% of minimum liquidity

    // Convert to wei (assuming USDC with 6 decimals)
    const loanAmount = ethers.utils.parseUnits(maxLoanAmount.toString(), 6);

    // Prepare arbitrage parameters
    const arbParams = {
      tokenIn: opportunity.tokenIn,
      tokenOut: opportunity.tokenOut,
      amountIn: loanAmount,
      fee1: 3000, // 0.3% fee
      fee2: 500,  // 0.05% fee
      useAerodrome: opportunity.dex1 === 'aerodrome' || opportunity.dex2 === 'aerodrome'
    };

    // Encode parameters
    const encodedParams = ethers.utils.defaultAbiCoder.encode(
      ['tuple(address,address,uint256,uint24,uint24,bool)'],
      [arbParams]
    );

    // Get optimal gas price
    const gasPrice = await getOptimalGasPrice();

    // Execute flash loan arbitrage
    const tx = await contract.executeFlashLoanArbitrage(
      opportunity.tokenIn,
      loanAmount,
      encodedParams,
      {
        gasPrice: gasPrice,
        gasLimit: 500000
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
          console.log("Executing arbitrage:", bestOpportunity);
          const result = await executeArbitrage(bestOpportunity);

          if (result.success) {
            console.log("Arbitrage successful! TX:", result.txHash);
          } else {
            console.log("Arbitrage failed:", result.error);
          }
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