const { ethers } = require("hardhat");

async function main() {
  console.log("Deploying BaseFlashLoanArbitrage contract to Base network...");

  // Base network addresses
  const AAVE_POOL_ADDRESSES_PROVIDER = "0xe20fcbdbffc4dd138ce8b2e6fbb6cb49777ad64d";
  
  // Get signers
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  
  // Get the contract factory
  const BaseFlashLoanArbitrage = await ethers.getContractFactory("BaseFlashLoanArbitrage");
  
  // Deploy the contract
  const contract = await BaseFlashLoanArbitrage.deploy(AAVE_POOL_ADDRESSES_PROVIDER);
  
  // Wait for deployment
  await contract.waitForDeployment();
  
  const contractAddress = await contract.getAddress();
  console.log(`BaseFlashLoanArbitrage deployed to: ${contractAddress}`);
  
  console.log("Contract deployed successfully!");
  
  // Return contract address for automation
  return contractAddress;
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = { main };