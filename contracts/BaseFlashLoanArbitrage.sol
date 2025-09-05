// SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import "@aave/core-v3/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol";
import "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

interface IUniswapV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
    
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

interface IQuoterV2 {
    function quoteExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint160 sqrtPriceLimitX96
    ) external returns (uint256 amountOut);
}

interface IAerodrome {
    function getAmountOut(uint amountIn, address tokenIn, address tokenOut) external view returns (uint amountOut, bool stable);
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);
}

contract BaseFlashLoanArbitrage is FlashLoanSimpleReceiverBase, Ownable, ReentrancyGuard {
    
    // Base Network Contract Addresses
    IUniswapV3SwapRouter public constant UNISWAP_ROUTER = IUniswapV3SwapRouter(0x2626664c2603336E57B271c5C0b26F421741e481);
    IQuoterV2 public constant QUOTER = IQuoterV2(0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a);
    
    // Base WETH address
    address public constant WETH = 0x4200000000000000000000000000000000000006;
    
    // Common stablecoins on Base
    address public constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address public constant USDbC = 0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA;
    
    // Fee structures for different pools
    uint24 public constant POOL_FEE_LOW = 500;    // 0.05%
    uint24 public constant POOL_FEE_MEDIUM = 3000; // 0.3%
    uint24 public constant POOL_FEE_HIGH = 10000;  // 1%
    
    // Arbitrage settings
    uint256 public minProfitBasisPoints = 50;  // 0.5% minimum profit
    uint256 public maxGasPrice = 50 gwei;
    uint256 public maxSlippage = 300; // 3%
    
    // Events
    event ArbitrageExecuted(
        address indexed asset,
        uint256 borrowAmount,
        uint256 profit,
        uint256 gasUsed
    );
    
    event ProfitWithdrawn(address indexed token, uint256 amount);
    
    struct ArbitrageParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee1;
        uint24 fee2;
        bool useAerodrome;
    }
    
    constructor(address _addressProvider) 
        FlashLoanSimpleReceiverBase(IPoolAddressesProvider(_addressProvider))
    {}
    
    /**
     * @dev Executes flash loan arbitrage
     * @param asset The asset to flash loan
     * @param amount The amount to flash loan
     * @param params Encoded arbitrage parameters
     */
    function executeFlashLoanArbitrage(
        address asset,
        uint256 amount,
        bytes calldata params
    ) external onlyOwner nonReentrant {
        require(tx.gasprice <= maxGasPrice, "Gas price too high");
        
        // Request flash loan
        POOL.flashLoanSimple(
            address(this),
            asset,
            amount,
            params,
            0
        );
    }
    
    /**
     * @dev Called by Aave pool after receiving the flash loan
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == address(POOL), "Invalid caller");
        require(initiator == address(this), "Invalid initiator");
        
        // Decode arbitrage parameters
        ArbitrageParams memory arbParams = abi.decode(params, (ArbitrageParams));
        
        // uint256 initialBalance = IERC20(asset).balanceOf(address(this));
        
        // Execute arbitrage logic
        uint256 profit = _executeArbitrage(arbParams, amount);
        
        // Calculate total amount to repay (loan + premium)
        uint256 totalDebt = amount + premium;
        
        // Ensure we have enough to repay the loan
        require(
            IERC20(asset).balanceOf(address(this)) >= totalDebt,
            "Insufficient funds to repay loan"
        );
        
        // Ensure arbitrage was profitable
        require(profit > 0, "Arbitrage not profitable");
        
        // Approve loan repayment
        IERC20(asset).approve(address(POOL), totalDebt);
        
        emit ArbitrageExecuted(asset, amount, profit, gasleft());
        
        return true;
    }
    
    /**
     * @dev Internal arbitrage execution logic
     */
    function _executeArbitrage(
        ArbitrageParams memory params,
        uint256 amount
    ) internal returns (uint256 profit) {
        uint256 startBalance = IERC20(params.tokenIn).balanceOf(address(this));
        
        // Step 1: Swap on first DEX (Uniswap)
        uint256 firstSwapOut = _swapUniswapV3(
            params.tokenIn,
            params.tokenOut,
            amount,
            params.fee1
        );
        
        // Step 2: Swap back on second DEX (Uniswap with different fee or Aerodrome)
        uint256 secondSwapOut;
        if (params.useAerodrome) {
            secondSwapOut = _swapAerodrome(params.tokenOut, params.tokenIn, firstSwapOut);
        } else {
            secondSwapOut = _swapUniswapV3(
                params.tokenOut,
                params.tokenIn,
                firstSwapOut,
                params.fee2
            );
        }
        
        uint256 endBalance = IERC20(params.tokenIn).balanceOf(address(this));
        profit = endBalance > startBalance ? endBalance - startBalance : 0;
        
        return profit;
    }
    
    /**
     * @dev Executes swap on Uniswap V3
     */
    function _swapUniswapV3(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint24 fee
    ) internal returns (uint256 amountOut) {
        IERC20(tokenIn).approve(address(UNISWAP_ROUTER), amountIn);
        
        IUniswapV3SwapRouter.ExactInputSingleParams memory params = IUniswapV3SwapRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: address(this),
            deadline: block.timestamp + 300,
            amountIn: amountIn,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        });
        
        return UNISWAP_ROUTER.exactInputSingle(params);
    }
    
    /**
     * @dev Executes swap on Aerodrome (placeholder - implement actual Aerodrome swap)
     */
    function _swapAerodrome(
        address, // tokenIn
        address, // tokenOut
        uint256 amountIn
    ) internal pure returns (uint256 amountOut) {
        // This would require actual Aerodrome router implementation
        // For now, return input amount as placeholder
        return amountIn;
    }
    
    /**
     * @dev Checks arbitrage opportunity and calculates optimal loan amount
     */
    function calculateArbitrageOpportunity(
        address tokenA,
        address tokenB,
        uint24 fee1,
        uint24 fee2,
        uint256 testAmount
    ) external returns (
        bool profitable,
        uint256 expectedProfit,
        uint256 optimalAmount
    ) {
        // Get quotes from both pools
        uint256 quote1 = _getUniswapQuote(tokenA, tokenB, testAmount, fee1);
        uint256 quote2 = _getUniswapQuote(tokenB, tokenA, quote1, fee2);
        
        if (quote2 > testAmount) {
            uint256 profit = quote2 - testAmount;
            uint256 profitBasisPoints = (profit * 10000) / testAmount;
            
            profitable = profitBasisPoints >= minProfitBasisPoints;
            expectedProfit = profit;
            optimalAmount = testAmount; // Could be optimized further
        }
        
        return (profitable, expectedProfit, optimalAmount);
    }
    
    /**
     * @dev Gets quote from Uniswap V3
     */
    function _getUniswapQuote(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint24 fee
    ) internal returns (uint256 amountOut) {
        try QUOTER.quoteExactInputSingle(tokenIn, tokenOut, fee, amountIn, 0) returns (uint256 quote) {
            return quote;
        } catch {
            return 0;
        }
    }
    
    /**
     * @dev Updates arbitrage settings
     */
    function updateSettings(
        uint256 _minProfitBasisPoints,
        uint256 _maxGasPrice,
        uint256 _maxSlippage
    ) external onlyOwner {
        minProfitBasisPoints = _minProfitBasisPoints;
        maxGasPrice = _maxGasPrice;
        maxSlippage = _maxSlippage;
    }
    
    /**
     * @dev Withdraws profits to owner
     */
    function withdrawProfits(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "No profits to withdraw");
        
        IERC20(token).transfer(owner(), balance);
        emit ProfitWithdrawn(token, balance);
    }
    
    /**
     * @dev Emergency function to withdraw ETH
     */
    function withdrawETH() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "No ETH to withdraw");
        payable(owner()).transfer(balance);
    }
    
    /**
     * @dev Allows contract to receive ETH
     */
    receive() external payable {}
}