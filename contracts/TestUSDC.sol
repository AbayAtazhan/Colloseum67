// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/**
 * @title TestUSDC
 * @notice Local-only 6-decimals ERC-20 used by the contract-path tests and the
 * local demo. On Base Sepolia the project uses the official Circle USDC
 * (0x036CbD53842c5426634e7929541eC2318f3dCF7e); this mock only exists so that
 * the full delegation flow can be proven against a real EVM without spending
 * faucet funds.
 */
contract TestUSDC {
    string public name = "Test USD Coin";
    string public symbol = "USDC";
    uint8 public immutable decimals;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "TestUSDC:insufficient-allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "TestUSDC:zero-address");
        uint256 balance = balanceOf[from];
        require(balance >= amount, "TestUSDC:insufficient-balance");
        unchecked {
            balanceOf[from] = balance - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }
}
