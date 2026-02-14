/**
 * Deploy a minimal ERC721 NFT contract to Ronin Saigon testnet
 * and mint a few test NFTs.
 *
 * Usage:
 *   PRIVATE_KEY=0x... npx tsx scripts/deploy-test-nft.ts
 */

import { ethers } from "ethers";

const RPC_URL = "https://saigon-testnet.roninchain.com/rpc";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error("❌ Set PRIVATE_KEY env var");
  process.exit(1);
}

// Minimal ERC721 contract — Solidity compiled bytecode
// This is a hand-crafted minimal ERC721 with:
//   - mint(address to, uint256 tokenId) — public, anyone can mint
//   - name() = "OOB Test NFT"
//   - symbol() = "OOBT"
//   - Standard ERC721 transfers, approvals, etc.
//
// We use the OpenZeppelin ERC721 compiled bytecode directly to avoid
// needing solc. This was compiled from:
//
// pragma solidity ^0.8.20;
// import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
// contract TestNFT is ERC721 {
//     constructor() ERC721("OOB Test NFT", "OOBT") {}
//     function mint(address to, uint256 tokenId) external {
//         _mint(to, tokenId);
//     }
// }

// Instead of embedding huge bytecode, let's deploy using CREATE with inline assembly.
// Simpler approach: use ethers ContractFactory with ABI + bytecode from a minimal contract.

// Actually, the simplest approach: deploy raw bytecode of a minimal ERC721.
// Let me use a different strategy — deploy via ethers with Solidity inline.

// Minimal ERC721 ABI for deployment and interaction
const ABI = [
  "constructor()",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function mint(address to, uint256 tokenId)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address to, uint256 tokenId)",
  "function setApprovalForAll(address operator, bool approved)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function transferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)",
  "event ApprovalForAll(address indexed owner, address indexed operator, bool approved)",
];

// Solidity source for reference — we'll compile it on-the-fly using solc-js
// But solc-js is heavy. Let's use a pre-compiled approach instead.
// 
// The most practical approach: use Foundry's forge to compile, or just
// provide the bytecode directly.
//
// Let me take the simplest possible route: use ethers to deploy a contract
// from raw EVM bytecode. I'll construct a minimal ERC721 using known patterns.

// Actually, let's just use the solc npm package to compile inline.
// But that's also heavy. The SIMPLEST approach for a test:
// Use a raw transaction to deploy pre-compiled bytecode.

// I'll use a different strategy: compile with solcjs at runtime.
// First check if solc is available, otherwise use a hardcoded bytecode.

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, {
    name: "ronin-saigon",
    chainId: 202601,
  });
  const wallet = new ethers.Wallet(PRIVATE_KEY!, provider);
  
  console.log("=== OOB Test NFT Deployment ===\n");
  console.log(`Network:  Ronin Saigon (202601)`);
  console.log(`Deployer: ${wallet.address}`);
  
  const balance = await provider.getBalance(wallet.address);
  console.log(`Balance:  ${ethers.formatEther(balance)} RON\n`);
  
  if (balance === 0n) {
    console.error("❌ No RON balance. Get testnet RON from https://faucet.roninchain.com/");
    process.exit(1);
  }

  // Use solc to compile a minimal contract
  let solc: any;
  try {
    solc = require("solc");
  } catch {
    console.log("Installing solc...");
    const { execSync } = require("child_process");
    execSync("npm install solc@0.8.28", { stdio: "inherit" });
    solc = require("solc");
  }

  const source = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract TestNFT {
    string public name = "OOB Test NFT";
    string public symbol = "OOBT";

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    function balanceOf(address owner) public view returns (uint256) {
        require(owner != address(0), "zero address");
        return _balances[owner];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address owner = _owners[tokenId];
        require(owner != address(0), "nonexistent token");
        return owner;
    }

    function tokenURI(uint256 tokenId) public view returns (string memory) {
        require(_owners[tokenId] != address(0), "nonexistent token");
        return string(abi.encodePacked("https://oob-test.example/", _toString(tokenId)));
    }

    function approve(address to, uint256 tokenId) public {
        address owner = ownerOf(tokenId);
        require(msg.sender == owner || _operatorApprovals[owner][msg.sender], "not authorized");
        _tokenApprovals[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function getApproved(uint256 tokenId) public view returns (address) {
        require(_owners[tokenId] != address(0), "nonexistent token");
        return _tokenApprovals[tokenId];
    }

    function setApprovalForAll(address operator, bool approved) public {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address owner, address operator) public view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        require(_isApprovedOrOwner(msg.sender, tokenId), "not authorized");
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) public {
        transferFrom(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory) public {
        transferFrom(from, to, tokenId);
    }

    function mint(address to, uint256 tokenId) external {
        require(to != address(0), "mint to zero");
        require(_owners[tokenId] == address(0), "already minted");
        _balances[to] += 1;
        _owners[tokenId] = to;
        emit Transfer(address(0), to, tokenId);
    }

    function supportsInterface(bytes4 interfaceId) public pure returns (bool) {
        return interfaceId == 0x80ac58cd  // ERC721
            || interfaceId == 0x5b5e139f  // ERC721Metadata
            || interfaceId == 0x01ffc9a7; // ERC165
    }

    function _isApprovedOrOwner(address spender, uint256 tokenId) internal view returns (bool) {
        address owner = ownerOf(tokenId);
        return (spender == owner || _tokenApprovals[tokenId] == spender || _operatorApprovals[owner][spender]);
    }

    function _transfer(address from, address to, uint256 tokenId) internal {
        require(ownerOf(tokenId) == from, "wrong owner");
        require(to != address(0), "transfer to zero");
        delete _tokenApprovals[tokenId];
        _balances[from] -= 1;
        _balances[to] += 1;
        _owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (value != 0) { digits--; buffer[digits] = bytes1(uint8(48 + value % 10)); value /= 10; }
        return string(buffer);
    }
}
`;

  console.log("Compiling contract...");
  
  const input = JSON.stringify({
    language: "Solidity",
    sources: { "TestNFT.sol": { content: source } },
    settings: {
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
      optimizer: { enabled: true, runs: 200 },
    },
  });

  const output = JSON.parse(solc.compile(input));
  
  if (output.errors?.some((e: any) => e.severity === "error")) {
    console.error("Compilation errors:");
    output.errors.forEach((e: any) => console.error(e.formattedMessage));
    process.exit(1);
  }

  const compiled = output.contracts["TestNFT.sol"]["TestNFT"];
  const bytecode = "0x" + compiled.evm.bytecode.object;
  const abi = compiled.abi;

  console.log(`Bytecode size: ${bytecode.length / 2} bytes`);
  console.log("\nDeploying...");

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  
  const address = await contract.getAddress();
  console.log(`\n✅ Contract deployed: ${address}`);
  console.log(`   Explorer: https://saigon-app.roninchain.com/address/${address}`);

  // Mint 5 test NFTs
  console.log("\nMinting 5 test NFTs...");
  for (let i = 1; i <= 5; i++) {
    const tx = await (contract as any).mint(wallet.address, i);
    await tx.wait();
    console.log(`  ✅ Minted #${i} → ${wallet.address}`);
  }

  console.log("\n=== Done ===");
  console.log(`\nContract: ${address}`);
  console.log(`Owner:    ${wallet.address}`);
  console.log(`Tokens:   #1 through #5`);
  console.log(`\nYou can now list these on the marketplace!`);
  console.log(`Chain: Ronin Saigon (2021)`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
