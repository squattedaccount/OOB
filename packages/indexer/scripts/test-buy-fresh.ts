/**
 * Fresh buy test: List token #15 from Wallet3, buy with Wallet1, verify webhook.
 */
import { ethers } from "ethers";

const RPC_URL = "https://saigon-testnet.roninchain.com/rpc";
const CHAIN_ID = 202601;
const OOB_API = "https://oob-api.sm-p.workers.dev";
const SEAPORT_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395";
const NFT_CONTRACT = "0x56F2BE0a1752E0A06A0A6409d5334151aA631CcD";

const SELLER_PK = "f0c7973600631c4431491d311ceb727bf99c12ea72ebf1be998c59cf80d627ae"; // Wallet3
const BUYER_PK = "5b069523982981d1d0cc9aa163359a7ef9a37123b9c81c89be5205df9bdb25ff"; // Wallet1
const TOKEN_ID = "15";
const PRICE = ethers.parseEther("0.008");

const SEAPORT_ABI = [
  "function fulfillOrder(((address offerer, address zone, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount)[] offer, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount, address recipient)[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 totalOriginalConsiderationItems) parameters, bytes signature) order, bytes32 fulfillerConduitKey) payable returns (bool fulfilled)",
  "function getCounter(address offerer) view returns (uint256 counter)",
];

const SEAPORT_DOMAIN = {
  name: "Seaport", version: "1.6", chainId: CHAIN_ID, verifyingContract: SEAPORT_ADDRESS,
};
const SEAPORT_TYPES = {
  OrderComponents: [
    { name: "offerer", type: "address" }, { name: "zone", type: "address" },
    { name: "offer", type: "OfferItem[]" }, { name: "consideration", type: "ConsiderationItem[]" },
    { name: "orderType", type: "uint8" }, { name: "startTime", type: "uint256" },
    { name: "endTime", type: "uint256" }, { name: "zoneHash", type: "bytes32" },
    { name: "salt", type: "uint256" }, { name: "conduitKey", type: "bytes32" },
    { name: "counter", type: "uint256" },
  ],
  OfferItem: [
    { name: "itemType", type: "uint8" }, { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" }, { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
  ],
  ConsiderationItem: [
    { name: "itemType", type: "uint8" }, { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" }, { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" }, { name: "recipient", type: "address" },
  ],
};

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, { name: "ronin-saigon", chainId: CHAIN_ID });
  const seller = new ethers.Wallet(SELLER_PK, provider);
  const buyer = new ethers.Wallet(BUYER_PK, provider);

  console.log("=== Fresh Buy Test ===\n");
  console.log(`Seller: ${seller.address} (Wallet3)`);
  console.log(`Buyer:  ${buyer.address} (Wallet1)`);
  console.log(`Token:  #${TOKEN_ID}, Price: ${ethers.formatEther(PRICE)} RON\n`);

  // Step 1: Create listing
  console.log("Step 1: Creating listing...");
  const seaport = new ethers.Contract(SEAPORT_ADDRESS, SEAPORT_ABI, seller);
  const counter = (await seaport.getCounter(seller.address)).toString();
  const now = Math.floor(Date.now() / 1000);
  const feeAmount = (PRICE * 50n) / 10000n;
  const sellerAmount = PRICE - feeAmount;

  const order = {
    offerer: seller.address,
    zone: "0x0000000000000000000000000000000000000000",
    offer: [{ itemType: 2, token: NFT_CONTRACT, identifierOrCriteria: TOKEN_ID, startAmount: "1", endAmount: "1" }],
    consideration: [
      { itemType: 0, token: "0x0000000000000000000000000000000000000000", identifierOrCriteria: "0", startAmount: sellerAmount.toString(), endAmount: sellerAmount.toString(), recipient: seller.address },
      { itemType: 0, token: "0x0000000000000000000000000000000000000000", identifierOrCriteria: "0", startAmount: feeAmount.toString(), endAmount: feeAmount.toString(), recipient: "0x0000000000000000000000000000000000000001" },
    ],
    orderType: 0,
    startTime: now.toString(),
    endTime: (now + 30 * 24 * 60 * 60).toString(),
    zoneHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    salt: "0x" + ethers.hexlify(ethers.randomBytes(32)).slice(2),
    conduitKey: "0x0000000000000000000000000000000000000000000000000000000000000000",
    counter,
    totalOriginalConsiderationItems: 2,
  };

  const signature = await seller.signTypedData(SEAPORT_DOMAIN, SEAPORT_TYPES, order);

  const submitRes = await fetch(`${OOB_API}/v1/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ chainId: CHAIN_ID, order, signature }),
  });
  const submitData = await submitRes.json() as any;
  if (!submitData?.orderHash) {
    console.error("❌ Failed to submit listing:", submitData);
    process.exit(1);
  }
  const orderHash = submitData.orderHash;
  console.log(`✅ Listed: ${orderHash.slice(0, 20)}...\n`);

  // Step 2: Buy it
  console.log("Step 2: Buying via Seaport fulfillOrder...");
  const seaportBuyer = new ethers.Contract(SEAPORT_ADDRESS, SEAPORT_ABI, buyer);

  const orderParams = {
    offerer: order.offerer, zone: order.zone,
    offer: order.offer.map((o: any) => ({ itemType: o.itemType, token: o.token, identifierOrCriteria: o.identifierOrCriteria, startAmount: o.startAmount, endAmount: o.endAmount })),
    consideration: order.consideration.map((c: any) => ({ itemType: c.itemType, token: c.token, identifierOrCriteria: c.identifierOrCriteria, startAmount: c.startAmount, endAmount: c.endAmount, recipient: c.recipient })),
    orderType: order.orderType, startTime: order.startTime, endTime: order.endTime,
    zoneHash: order.zoneHash, salt: order.salt, conduitKey: order.conduitKey,
    totalOriginalConsiderationItems: order.totalOriginalConsiderationItems,
  };

  const tx = await seaportBuyer.fulfillOrder(
    { parameters: orderParams, signature },
    "0x0000000000000000000000000000000000000000000000000000000000000000",
    { value: PRICE },
  );
  console.log(`Tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`✅ Confirmed in block ${receipt.blockNumber}\n`);

  // Step 3: Wait for webhook
  console.log("Step 3: Waiting for Alchemy webhook to update order status...");
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    const checkRes = await fetch(`${OOB_API}/v1/orders/${orderHash}`, { headers: { accept: "application/json" } });
    const checkData = await checkRes.json() as any;
    const status = checkData?.order?.status;
    const elapsed = (i + 1) * 10;
    console.log(`  [${elapsed}s] status=${status}${checkData?.order?.filledTxHash ? ` tx=${checkData.order.filledTxHash.slice(0, 18)}...` : ""}`);
    if (status === "filled") {
      console.log(`\n✅ ORDER MARKED AS FILLED BY WEBHOOK!`);
      break;
    }
    if (status === "stale") {
      console.log(`\n⚠️  Order marked as stale by cron (webhook may not have fired)`);
      break;
    }
    if (i === 11) {
      console.log(`\n⚠️  Order still ${status} after 120s. Webhook may need more time.`);
    }
  }

  // Step 4: Check activity
  const actRes = await fetch(`${OOB_API}/v1/activity?chainId=${CHAIN_ID}&orderHash=${orderHash}`, { headers: { accept: "application/json" } });
  const actData = await actRes.json() as any;
  console.log(`\nActivity for this order:`);
  for (const evt of actData?.activity || []) {
    console.log(`  [${evt.eventType}] at ${evt.createdAt}${evt.txHash ? ` tx:${evt.txHash.slice(0, 18)}...` : ""}`);
  }

  console.log("\n=== Done ===");
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
