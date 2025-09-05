require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [
      {
        version: "0.6.12",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200
          }
        }
      },
      {
        version: "0.8.10",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200
          }
        }
      }
    ]
  },
  networks: {
    hardhat: {
      chainId: 1337
    },
    base: {
      url: "https://mainnet.base.org",
      accounts: ["0xd46c12869e0e964d117b67f39deb8c2a8359aaede080162ab0c0acefb234f5e8"],
      chainId: 8453
    },
    baseSepolia: {
      url: "https://sepolia.base.org",
      accounts: ["0xd46c12869e0e964d117b67f39deb8c2a8359aaede080162ab0c0acefb234f5e8"],
      chainId: 84532
    }
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  }
};