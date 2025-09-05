# Flash Loan Arbitrage Smart Contracts

## Project Overview
This is a Solidity smart contract project for DeFi arbitrage trading and flash loans on Ethereum. The project contains three main contracts that demonstrate automated arbitrage between DEXs and flash loan functionality using Aave protocol.

## Project Structure
- `contracts/` - Solidity smart contracts
  - `Arbitrage.sol` - Automated arbitrage trading between Uniswap and Sushiswap
  - `FlashLoan.sol` - Simple flash loan implementation using Aave
  - `Flash-Loan-Arbitrage.sol` - Combined flash loan and arbitrage strategies
  - `SafeERC20.sol` - OpenZeppelin SafeERC20 wrapper
  - `Ownable.sol` - OpenZeppelin Ownable wrapper

## Technology Stack
- **Language**: Solidity (v0.6.12 and v0.8.10)
- **Framework**: Hardhat 2.26.3
- **Dependencies**: 
  - OpenZeppelin Contracts
  - Uniswap V2 Periphery
  - Aave Core V3

## Development Environment
- **Node.js**: v20
- **Hardhat Network**: Local blockchain running on port 8000
- **Accounts**: 20 test accounts with 10,000 ETH each
- **Chain ID**: 1337

## Available Scripts
- `npm run compile` - Compile smart contracts
- `npm run dev` - Start Hardhat development node
- `npm run test` - Run tests
- `npm run console` - Start Hardhat console

## Current Status
✅ Project successfully set up in Replit environment
✅ All dependencies installed
✅ Smart contracts compile without errors
✅ Development blockchain running on port 8000
✅ Ready for smart contract development and testing

## Usage
The Hardhat development node is running automatically, providing a local blockchain for testing. You can interact with the contracts using:
- Hardhat console: `npm run console`
- Deploy scripts: `npm run deploy`
- Custom scripts via Hardhat tasks

## Recent Changes
- Set up complete Hardhat development environment
- Fixed compilation issues in flash loan contracts
- Configured proper imports for OpenZeppelin and Aave dependencies
- Established local blockchain network for testing