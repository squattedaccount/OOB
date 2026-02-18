/**
 * Focused test: Buy an NFT via Seaport fulfillOrder + verify webhook updates DB
 *
 * Uses existing listing for token #10 (Wallet1) — Wallet2 buys it.
 */

import { ethers } from "ethers";

const RPC_URL = "https://saigon-testnet.roninchain.com/rpc";
const CHAIN_ID = 202601;
const OOB_API = "https://oob-api.sm-p.workers.dev";
const SEAPORT_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395";
const NFT_CONTRACT = "0x56F2BE0a1752E0A06A0A6409d5334151aA631CcD";

const BUYER_PK = "01d1a896596dfbf11bbc47ed6a52fa5b94b602da92f5c64bb3dd98b9b1350e7c";

// Seaport ABI — Order = (OrderParameters, bytes signature)
const SEAPORT_ABI = [
  "function fulfillOrder(((address offerer, address zone, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount)[] offer, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount, address recipient)[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 totalOriginalConsiderationItems) parameters, bytes signature) order, bytes32 fulfillerConduitKey) payable returns (bool fulfilled)",
  "function getCounter(address offerer) view returns (uint256 counter)",
];

const NFT_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, { name: "ronin-saigon", chainId: CHAIN_ID });
  const buyer = new ethers.Wallet(BUYER_PK, provider);

  console.log("=== Buy Flow Test ===\n");
  console.log(`Buyer: ${buyer.address}`);
  const bal = await provider.getBalance(buyer.address);
  console.log(`Balance: ${ethers.formatEther(bal)} RON\n`);

  // Step 1: Find the listing for token #10
  const ORDER_HASH = "0x74c9051d0b36593739f3a80a2db79d534ccb74deb0408949d14f8ef1d6b0f70e";
  console.log(`Fetching order ${ORDER_HASH.slice(0, 20)}...`);

  const res = await fetch(`${OOB_API}/v1/orders/${ORDER_HASH}`, {
    headers: { accept: "application/json" },
  });
  const orderData = await res.json() as any;

  if (!orderData?.order) {
    console.error("❌ Order not found");
    process.exit(1);
  }

  const order = orderData.order;
  console.log(`Order: #${order.tokenId} by ${order.offerer.slice(0, 12)}... for ${ethers.formatEther(order.priceWei)} RON`);
  console.log(`Status: ${order.status}`);

  if (order.status !== "active") {
    console.error(`❌ Order is ${order.status}, not active`);
    process.exit(1);
  }

  const orderJson = order.orderJson;
  const sig = order.signature;

  // Step 2: Calculate total payment
  let totalPayment = 0n;
  for (const item of orderJson.consideration) {
    if (Number(item.itemType) === 0) {
      totalPayment += BigInt(item.startAmount);
    }
  }
  console.log(`\nTotal payment: ${ethers.formatEther(totalPayment)} RON`);

  // Step 3: Build the Order struct and call fulfillOrder
  const seaport = new ethers.Contract(SEAPORT_ADDRESS, SEAPORT_ABI, buyer);

  const orderParams = {
    offerer: orderJson.offerer,
    zone: orderJson.zone,
    offer: orderJson.offer.map((o: any) => ({
      itemType: o.itemType,
      token: o.token,
      identifierOrCriteria: o.identifierOrCriteria,
      startAmount: o.startAmount,
      endAmount: o.endAmount,
    })),
    consideration: orderJson.consideration.map((c: any) => ({
      itemType: c.itemType,
      token: c.token,
      identifierOrCriteria: c.identifierOrCriteria,
      startAmount: c.startAmount,
      endAmount: c.endAmount,
      recipient: c.recipient,
    })),
    orderType: orderJson.orderType,
    startTime: orderJson.startTime,
    endTime: orderJson.endTime,
    zoneHash: orderJson.zoneHash,
    salt: orderJson.salt,
    conduitKey: orderJson.conduitKey,
    totalOriginalConsiderationItems: orderJson.totalOriginalConsiderationItems,
  };

  const fullOrder = {
    parameters: orderParams,
    signature: sig,
  };

  console.log("\nSending fulfillOrder tx...");

  try {
    const tx = await seaport.fulfillOrder(
      fullOrder,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      { value: totalPayment },
    );
    console.log(`Tx hash: ${tx.hash}`);
    console.log("Waiting for confirmation...");

    const receipt = await tx.wait();
    console.log(`✅ Tx confirmed in block ${receipt.blockNumber}`);
    console.log(`Gas used: ${receipt.gasUsed.toString()}`);

    // Step 4: Verify NFT ownership
    const nft = new ethers.Contract(NFT_CONTRACT, NFT_ABI, provider);
    const newOwner = await nft.ownerOf(order.tokenId);
    if (newOwner.toLowerCase() === buyer.address.toLowerCase()) {
      console.log(`✅ NFT #${order.tokenId} now owned by buyer!`);
    } else {
      console.log(`❌ NFT owner is ${newOwner}, expected ${buyer.address}`);
    }

    // Step 5: Wait for webhook to update order status
    console.log("\nWaiting for Alchemy webhook to update order status...");
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 10000));
      const checkRes = await fetch(`${OOB_API}/v1/orders/${ORDER_HASH}`, {
        headers: { accept: "application/json" },
      });
      const checkData = await checkRes.json() as any;
      const status = checkData?.order?.status;
      console.log(`  [${(i + 1) * 10}s] Order status: ${status}`);
      if (status === "filled") {
        console.log(`✅ Order marked as 'filled' by webhook!`);
        console.log(`   filled_tx_hash: ${checkData.order.filledTxHash}`);
        break;
      }
      if (i === 5) {
        console.log("⚠️  Order not yet marked as filled after 60s. Webhook may be delayed.");
        console.log("   The cron job (every 5 min) will also detect stale orders.");
      }
    }

    // Step 6: Check activity log
    const actRes = await fetch(`${OOB_API}/v1/activity?chainId=${CHAIN_ID}&orderHash=${ORDER_HASH}`, {
      headers: { accept: "application/json" },
    });
    const actData = await actRes.json() as any;
    console.log(`\nActivity for this order:`);
    for (const evt of actData?.activity || []) {
      console.log(`  [${evt.eventType}] at ${evt.createdAt}${evt.txHash ? ` tx:${evt.txHash.slice(0, 18)}...` : ""}`);
    }

  } catch (err: any) {
    console.error("❌ fulfillOrder failed:", err.message);
    if (err.data) console.error("   Revert data:", err.data);
    if (err.reason) console.error("   Reason:", err.reason);

    // Try to get more info via estimateGas
    console.log("\nTrying estimateGas for more details...");
    try {
      await seaport.fulfillOrder.estimateGas(
        fullOrder,
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        { value: totalPayment, from: buyer.address },
      );
    } catch (estErr: any) {
      console.error("   estimateGas error:", estErr.message);
      if (estErr.data) console.error("   Revert data:", estErr.data);
    }
  }

  console.log("\n=== Done ===");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
