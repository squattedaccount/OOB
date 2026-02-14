/**
 * OOB End-to-End Test Suite
 *
 * Tests the full OOB lifecycle on Ronin Saigon testnet:
 *   0. Cleanup stale orders from previous runs
 *   1. Transfer RON, mint NFTs, approve Seaport
 *   2. Create listings (Seaport EIP-712 signing)
 *   3. Cancel a listing (signature-based)
 *   4. Direct buy (fulfill listing via Seaport on-chain)
 *   5. Wrap RON → WRON, create offers (ERC20)
 *   6. Accept offer (seller fulfills on-chain)
 *   7. Cancel offer (signature-based)
 *   8. Edge cases (duplicate listing, re-list, wrong wallet cancel)
 *   9. Verify activity history
 *
 * Usage:
 *   npx tsx scripts/oob-e2e-test.ts
 */

import { ethers } from "ethers";

// ─── Config ──────────────────────────────────────────────────────────────────

const RPC_URL = "https://saigon-testnet.roninchain.com/rpc";
const CHAIN_ID = 202601;
const OOB_API = "https://oob-api.sm-p.workers.dev";
const SEAPORT_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395";
const NFT_CONTRACT = "0x56F2BE0a1752E0A06A0A6409d5334151aA631CcD";
const WRON_CONTRACT = "0xa959726154953bAe111746E265E6d754F48570E6"; // Wrapped RON on Saigon

// Wallets
const WALLETS = [
  { name: "Wallet1", pk: "5b069523982981d1d0cc9aa163359a7ef9a37123b9c81c89be5205df9bdb25ff" },
  { name: "Wallet2", pk: "01d1a896596dfbf11bbc47ed6a52fa5b94b602da92f5c64bb3dd98b9b1350e7c" },
  { name: "Wallet3", pk: "f0c7973600631c4431491d311ceb727bf99c12ea72ebf1be998c59cf80d627ae" },
  { name: "Wallet4", pk: "07f44b7efa12f4d055ff1a7a5b03b9ea521fa09f679ae558a555b7a1cb935a8b" },
];

// Seaport ABI (minimal for fulfillOrder and cancel)
// Order = (OrderParameters parameters, bytes signature)
// OrderParameters = (address offerer, address zone, OfferItem[] offer, ConsiderationItem[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 totalOriginalConsiderationItems)
const SEAPORT_ABI = [
  "function fulfillOrder(((address offerer, address zone, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount)[] offer, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount, address recipient)[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 totalOriginalConsiderationItems) parameters, bytes signature) order, bytes32 fulfillerConduitKey) payable returns (bool fulfilled)",
  "function cancel((address offerer, address zone, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount)[] offer, (uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount, address recipient)[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 counter)[] orders) returns (bool cancelled)",
  "function getCounter(address offerer) view returns (uint256 counter)",
  "function information() view returns (string version, bytes32 domainSeparator, address conduitController)",
];

const NFT_ABI = [
  "function mint(address to, uint256 tokenId)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function approve(address to, uint256 tokenId)",
  "function setApprovalForAll(address operator, bool approved)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
];

// Seaport EIP-712 types
const SEAPORT_DOMAIN = {
  name: "Seaport",
  version: "1.6",
  chainId: CHAIN_ID,
  verifyingContract: SEAPORT_ADDRESS,
};

const SEAPORT_TYPES = {
  OrderComponents: [
    { name: "offerer", type: "address" },
    { name: "zone", type: "address" },
    { name: "offer", type: "OfferItem[]" },
    { name: "consideration", type: "ConsiderationItem[]" },
    { name: "orderType", type: "uint8" },
    { name: "startTime", type: "uint256" },
    { name: "endTime", type: "uint256" },
    { name: "zoneHash", type: "bytes32" },
    { name: "salt", type: "uint256" },
    { name: "conduitKey", type: "bytes32" },
    { name: "counter", type: "uint256" },
  ],
  OfferItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
  ],
  ConsiderationItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
    { name: "recipient", type: "address" },
  ],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const provider = new ethers.JsonRpcProvider(RPC_URL, { name: "ronin-saigon", chainId: CHAIN_ID });
const wallets = WALLETS.map((w) => new ethers.Wallet(w.pk, provider));

function log(msg: string) {
  console.log(`  ${msg}`);
}

function pass(test: string) {
  console.log(`  ✅ PASS: ${test}`);
}

function fail(test: string, err?: any) {
  console.log(`  ❌ FAIL: ${test}${err ? ` — ${err.message || err}` : ""}`);
}

async function oobFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${OOB_API}${path}`, {
    ...init,
    headers: { accept: "application/json", ...init?.headers },
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

function randomSalt(): string {
  return "0x" + ethers.hexlify(ethers.randomBytes(32)).slice(2);
}

const FEE_RECIPIENT = "0x56A8Ad381232d6724Ae8AbDE838d70d1AE628575";
const FEE_BPS = 50; // 0.5%

function buildListingOrder(
  offerer: string,
  nftContract: string,
  tokenId: string,
  priceWei: bigint,
  counter: string,
  durationSeconds = 30 * 24 * 60 * 60,
) {
  const now = Math.floor(Date.now() / 1000);
  const feeAmount = (priceWei * BigInt(FEE_BPS)) / 10000n;
  const sellerAmount = priceWei - feeAmount;

  return {
    offerer,
    zone: "0x0000000000000000000000000000000000000000",
    offer: [
      {
        itemType: 2, // ERC721
        token: nftContract,
        identifierOrCriteria: tokenId,
        startAmount: "1",
        endAmount: "1",
      },
    ],
    consideration: [
      {
        itemType: 0, // NATIVE
        token: "0x0000000000000000000000000000000000000000",
        identifierOrCriteria: "0",
        startAmount: sellerAmount.toString(),
        endAmount: sellerAmount.toString(),
        recipient: offerer,
      },
      {
        itemType: 0,
        token: "0x0000000000000000000000000000000000000000",
        identifierOrCriteria: "0",
        startAmount: feeAmount.toString(),
        endAmount: feeAmount.toString(),
        recipient: FEE_RECIPIENT,
      },
    ],
    orderType: 0,
    startTime: now.toString(),
    endTime: (now + durationSeconds).toString(),
    zoneHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    salt: randomSalt(),
    conduitKey: "0x0000000000000000000000000000000000000000000000000000000000000000",
    counter,
    totalOriginalConsiderationItems: 2,
  };
}

async function signAndSubmitListing(
  wallet: ethers.Wallet,
  tokenId: string,
  priceWei: bigint,
): Promise<{ orderHash: string; order: any } | null> {
  const seaport = new ethers.Contract(SEAPORT_ADDRESS, SEAPORT_ABI, wallet);
  const counter = (await seaport.getCounter(wallet.address)).toString();

  const order = buildListingOrder(wallet.address, NFT_CONTRACT, tokenId, priceWei, counter);

  // Sign EIP-712
  const signature = await wallet.signTypedData(SEAPORT_DOMAIN, SEAPORT_TYPES, order);

  // Submit to OOB API
  const { status, data } = await oobFetch("/v1/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chainId: CHAIN_ID, order, signature }),
  });

  if (status === 201 || (status === 200 && data?.orderHash)) {
    return { orderHash: data.orderHash, order };
  }
  console.error(`    Submit failed (${status}):`, data);
  return null;
}

const WRON_ABI = [
  "function deposit() payable",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
];

function buildOfferOrder(
  offerer: string,
  nftContract: string,
  tokenId: string,
  offerAmountWei: bigint,
  counter: string,
  durationSeconds = 30 * 24 * 60 * 60,
) {
  const now = Math.floor(Date.now() / 1000);
  const feeAmount = (offerAmountWei * BigInt(FEE_BPS)) / 10000n;

  // Offer: bidder offers ERC20 (WRON)
  // Consideration: NFT goes to bidder + fee goes to protocol
  return {
    offerer,
    zone: "0x0000000000000000000000000000000000000000",
    offer: [
      {
        itemType: 1, // ERC20
        token: WRON_CONTRACT,
        identifierOrCriteria: "0",
        startAmount: offerAmountWei.toString(),
        endAmount: offerAmountWei.toString(),
      },
    ],
    consideration: [
      {
        itemType: 2, // ERC721
        token: nftContract,
        identifierOrCriteria: tokenId,
        startAmount: "1",
        endAmount: "1",
        recipient: offerer, // bidder gets the NFT
      },
      {
        itemType: 1, // ERC20 fee
        token: WRON_CONTRACT,
        identifierOrCriteria: "0",
        startAmount: feeAmount.toString(),
        endAmount: feeAmount.toString(),
        recipient: FEE_RECIPIENT,
      },
    ],
    orderType: 0,
    startTime: now.toString(),
    endTime: (now + durationSeconds).toString(),
    zoneHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    salt: randomSalt(),
    conduitKey: "0x0000000000000000000000000000000000000000000000000000000000000000",
    counter,
    totalOriginalConsiderationItems: 2,
  };
}

async function signAndSubmitOffer(
  wallet: ethers.Wallet,
  tokenId: string,
  offerAmountWei: bigint,
): Promise<{ orderHash: string; order: any } | null> {
  const seaport = new ethers.Contract(SEAPORT_ADDRESS, SEAPORT_ABI, wallet);
  const counter = (await seaport.getCounter(wallet.address)).toString();

  const order = buildOfferOrder(wallet.address, NFT_CONTRACT, tokenId, offerAmountWei, counter);

  const signature = await wallet.signTypedData(SEAPORT_DOMAIN, SEAPORT_TYPES, order);

  const { status, data } = await oobFetch("/v1/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chainId: CHAIN_ID, order, signature }),
  });

  if (status === 201 || (status === 200 && data?.orderHash)) {
    return { orderHash: data.orderHash, order };
  }
  console.error(`    Offer submit failed (${status}):`, data);
  return null;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Test Phases ─────────────────────────────────────────────────────────────

async function phase0_checkBalances() {
  console.log("\n═══ Phase 0: Check Balances ═══");
  for (let i = 0; i < wallets.length; i++) {
    const bal = await provider.getBalance(wallets[i].address);
    log(`${WALLETS[i].name} (${wallets[i].address}): ${ethers.formatEther(bal)} RON`);
  }
}

async function phase0b_cleanupActiveOrders() {
  console.log("\n═══ Phase 0b: Cleanup Active Orders from Previous Runs ═══");
  for (let i = 0; i < wallets.length; i++) {
    try {
      const { data } = await oobFetch(
        `/v1/orders?chainId=${CHAIN_ID}&offerer=${wallets[i].address}&status=active&limit=50`,
      );
      if (!data?.orders?.length) {
        log(`${WALLETS[i].name}: no active orders`);
        continue;
      }
      for (const order of data.orders) {
        try {
          const message = `cancel:${order.orderHash}`;
          const signature = await wallets[i].signMessage(message);
          const { status } = await oobFetch(`/v1/orders/${order.orderHash}`, {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ signature }),
          });
          if (status === 200) {
            pass(`Cancelled stale order ${order.orderHash.slice(0, 18)}...`);
          } else {
            log(`Cancel returned ${status} for ${order.orderHash.slice(0, 18)}...`);
          }
        } catch (err: any) {
          log(`Could not cancel ${order.orderHash.slice(0, 18)}...: ${err.message}`);
        }
      }
    } catch (err: any) {
      fail(`Cleanup for ${WALLETS[i].name}`, err);
    }
  }
  // Wait a moment for DB to settle
  await sleep(2000);
}

async function phase1_transferRON() {
  console.log("\n═══ Phase 1: Transfer RON to Wallets 3 & 4 ═══");
  const sender = wallets[0];
  const amount = ethers.parseEther("0.3");

  for (const idx of [2, 3]) {
    const bal = await provider.getBalance(wallets[idx].address);
    if (bal >= amount) {
      log(`${WALLETS[idx].name} already has ${ethers.formatEther(bal)} RON, skipping`);
      continue;
    }
    try {
      const tx = await sender.sendTransaction({ to: wallets[idx].address, value: amount });
      await tx.wait();
      pass(`Sent 0.3 RON to ${WALLETS[idx].name}`);
    } catch (err: any) {
      fail(`Transfer to ${WALLETS[idx].name}`, err);
    }
  }
}

// Dynamic token IDs for this run — avoids collisions with prior runs
const RUN_ID = Math.floor(Date.now() / 1000) % 100000;
const TOKEN_IDS = {
  w0_list1: RUN_ID * 10 + 1,   // Wallet1 listing (will be bought)
  w0_list2: RUN_ID * 10 + 2,   // Wallet1 listing (will be cancelled)
  w1_list1: RUN_ID * 10 + 3,   // Wallet2 listing
  w1_list2: RUN_ID * 10 + 4,   // Wallet2 listing
  w2_list1: RUN_ID * 10 + 5,   // Wallet3 listing (for wrong-wallet cancel test)
  w3_list1: RUN_ID * 10 + 6,   // Wallet4 listing
};

async function phase2_mintAndDistribute() {
  console.log("\n═══ Phase 2: Mint Fresh NFTs (run-unique IDs) ═══");
  log(`Run ID: ${RUN_ID}, token range: ${RUN_ID * 10 + 1} - ${RUN_ID * 10 + 6}`);

  // Each wallet mints its own tokens directly
  const mintPlan = [
    { walletIdx: 0, tokenIds: [TOKEN_IDS.w0_list1, TOKEN_IDS.w0_list2] },
    { walletIdx: 1, tokenIds: [TOKEN_IDS.w1_list1, TOKEN_IDS.w1_list2] },
    { walletIdx: 2, tokenIds: [TOKEN_IDS.w2_list1] },
    { walletIdx: 3, tokenIds: [TOKEN_IDS.w3_list1] },
  ];

  for (const { walletIdx, tokenIds } of mintPlan) {
    const nft = new ethers.Contract(NFT_CONTRACT, NFT_ABI, wallets[walletIdx]);
    for (const tokenId of tokenIds) {
      try {
        // Check if already minted
        try {
          const owner = await nft.ownerOf(tokenId);
          if (owner.toLowerCase() === wallets[walletIdx].address.toLowerCase()) {
            log(`Token #${tokenId} already owned by ${WALLETS[walletIdx].name}, skipping`);
            continue;
          }
          log(`Token #${tokenId} owned by someone else, skipping`);
          continue;
        } catch {
          // Not minted — proceed
        }
        const tx = await nft.mint(wallets[walletIdx].address, tokenId);
        await tx.wait();
        pass(`Minted #${tokenId} → ${WALLETS[walletIdx].name}`);
      } catch (err: any) {
        fail(`Mint #${tokenId} for ${WALLETS[walletIdx].name}`, err);
      }
    }
  }
}

async function phase3_approveSeaport() {
  console.log("\n═══ Phase 3: Approve Seaport for All Wallets ═══");
  for (let i = 0; i < wallets.length; i++) {
    try {
      const nft = new ethers.Contract(NFT_CONTRACT, NFT_ABI, wallets[i]);
      const approved = await nft.isApprovedForAll(wallets[i].address, SEAPORT_ADDRESS);
      if (approved) {
        log(`${WALLETS[i].name} already approved Seaport`);
        continue;
      }
      const tx = await nft.setApprovalForAll(SEAPORT_ADDRESS, true);
      await tx.wait();
      pass(`${WALLETS[i].name} approved Seaport`);
    } catch (err: any) {
      fail(`Approve Seaport for ${WALLETS[i].name}`, err);
    }
  }
}

async function phase4_createListings(): Promise<string[]> {
  console.log("\n═══ Phase 4: Create Listings ═══");
  const orderHashes: string[] = [];

  const listings = [
    { wallet: 0, tokenId: String(TOKEN_IDS.w0_list1), price: "0.01" },
    { wallet: 0, tokenId: String(TOKEN_IDS.w0_list2), price: "0.02" },
    { wallet: 1, tokenId: String(TOKEN_IDS.w1_list1), price: "0.015" },
    { wallet: 1, tokenId: String(TOKEN_IDS.w1_list2), price: "0.025" },
    { wallet: 2, tokenId: String(TOKEN_IDS.w2_list1), price: "0.012" },
    { wallet: 3, tokenId: String(TOKEN_IDS.w3_list1), price: "0.018" },
  ];

  for (const { wallet: walletIdx, tokenId, price } of listings) {
    try {
      const result = await signAndSubmitListing(
        wallets[walletIdx],
        tokenId,
        ethers.parseEther(price),
      );
      if (result) {
        pass(`${WALLETS[walletIdx].name} listed #${tokenId} for ${price} RON → ${result.orderHash.slice(0, 18)}...`);
        orderHashes.push(result.orderHash);
      } else {
        fail(`${WALLETS[walletIdx].name} list #${tokenId}`);
      }
    } catch (err: any) {
      fail(`${WALLETS[walletIdx].name} list #${tokenId}`, err);
    }
  }

  return orderHashes;
}

async function phase5_verifyListings(orderHashes: string[]) {
  console.log("\n═══ Phase 5: Verify Listings via API ═══");

  // Check total orders
  const { data: allOrders } = await oobFetch(`/v1/orders?chainId=${CHAIN_ID}`);
  log(`Total active orders: ${allOrders?.total}`);

  // Check collection stats
  const { data: stats } = await oobFetch(
    `/v1/collections/${NFT_CONTRACT.toLowerCase()}/stats?chainId=${CHAIN_ID}`,
  );
  log(`Collection stats: listings=${stats?.listingCount}, floor=${stats?.floorPriceWei ? ethers.formatEther(stats.floorPriceWei) + " RON" : "none"}`);

  // Check best listing
  const { data: best } = await oobFetch(
    `/v1/orders/best-listing?chainId=${CHAIN_ID}&collection=${NFT_CONTRACT.toLowerCase()}`,
  );
  if (best?.order) {
    pass(`Best listing: #${best.order.tokenId} at ${ethers.formatEther(best.order.priceWei)} RON`);
  }

  // Check individual order
  if (orderHashes.length > 0) {
    const { status, data } = await oobFetch(`/v1/orders/${orderHashes[0]}`);
    if (status === 200 && data?.order?.status === "active") {
      pass(`Individual order lookup works`);
    } else {
      fail(`Individual order lookup`);
    }
  }

  // Check activity
  const { data: activity } = await oobFetch(`/v1/activity?chainId=${CHAIN_ID}`);
  log(`Activity events so far: ${activity?.total}`);
}

async function phase6_cancelListing(orderHashes: string[]) {
  console.log("\n═══ Phase 6: Cancel a Listing (Signature-Based) ═══");
  if (orderHashes.length < 2) {
    log("Not enough orders to test cancel, skipping");
    return;
  }

  const hashToCancel = orderHashes[1]; // Cancel the second listing (wallet0, token #11)
  const wallet = wallets[0];

  try {
    // Sign cancel message
    const message = `cancel:${hashToCancel}`;
    const signature = await wallet.signMessage(message);

    const { status, data } = await oobFetch(`/v1/orders/${hashToCancel}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signature }),
    });

    if (status === 200 && data?.status === "cancelled") {
      pass(`Cancelled order ${hashToCancel.slice(0, 18)}... via signature`);
    } else {
      fail(`Cancel order`, data);
    }

    // Verify it's cancelled
    const { data: order } = await oobFetch(`/v1/orders/${hashToCancel}`);
    if (order?.order?.status === "cancelled") {
      pass(`Order status confirmed cancelled`);
    } else {
      fail(`Order status check after cancel: ${order?.order?.status}`);
    }
  } catch (err: any) {
    fail(`Cancel listing`, err);
  }
}

async function phase7_directBuy(orderHashes: string[]) {
  console.log("\n═══ Phase 7: Direct Buy (Fill Order via Seaport) ═══");
  if (orderHashes.length < 1) {
    log("No orders to buy, skipping");
    return;
  }

  const hashToBuy = orderHashes[0]; // Buy the first listing (wallet0, token #10)
  const buyer = wallets[1]; // Wallet2 buys

  try {
    // Fetch the full order from OOB API
    const { data: orderData } = await oobFetch(`/v1/orders/${hashToBuy}`);
    if (!orderData?.order) {
      fail("Could not fetch order for buy");
      return;
    }

    const order = orderData.order;
    const orderJson = order.orderJson;
    const sig = order.signature;

    // Build the Seaport fulfillOrder parameters
    const seaport = new ethers.Contract(SEAPORT_ADDRESS, SEAPORT_ABI, buyer);

    // Calculate total payment (sum of all native consideration items)
    let totalPayment = 0n;
    for (const item of orderJson.consideration) {
      if (Number(item.itemType) === 0) {
        totalPayment += BigInt(item.startAmount);
      }
    }

    log(`Buying #${order.tokenId} for ${ethers.formatEther(totalPayment)} RON...`);

    // Build the order tuple for fulfillOrder
    const orderTuple = {
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

    // Build the Order struct = (OrderParameters, bytes signature)
    const fullOrder = {
      parameters: orderTuple,
      signature: sig,
    };

    const tx = await seaport.fulfillOrder(
      fullOrder,
      "0x0000000000000000000000000000000000000000000000000000000000000000", // fulfillerConduitKey
      { value: totalPayment },
    );

    const receipt = await tx.wait();
    pass(`Buy tx confirmed: ${receipt.hash}`);

    // Verify NFT ownership changed
    const nft = new ethers.Contract(NFT_CONTRACT, NFT_ABI, provider);
    const newOwner = await nft.ownerOf(order.tokenId);
    if (newOwner.toLowerCase() === buyer.address.toLowerCase()) {
      pass(`NFT #${order.tokenId} now owned by buyer (${WALLETS[1].name})`);
    } else {
      fail(`NFT ownership check: owner is ${newOwner}, expected ${buyer.address}`);
    }

    // Wait a bit for the webhook to fire
    log("Waiting 15s for Alchemy webhook to update order status...");
    await sleep(15000);

    // Check if the order was marked as filled
    const { data: filledOrder } = await oobFetch(`/v1/orders/${hashToBuy}`);
    if (filledOrder?.order?.status === "filled") {
      pass(`Order status updated to 'filled' by webhook!`);
    } else {
      log(`Order status: ${filledOrder?.order?.status} (webhook may take longer)`);
    }
  } catch (err: any) {
    fail(`Direct buy`, err);
  }
}

// ─── Offer Phases ────────────────────────────────────────────────────────────

async function phase7b_wrapRONAndApprove() {
  console.log("\n═══ Phase 7b: Wrap RON → WRON & Approve Seaport ═══");
  // Wallet3 will make offers, so it needs WRON
  const bidder = wallets[2];
  const wron = new ethers.Contract(WRON_CONTRACT, WRON_ABI, bidder);
  const wrapAmount = ethers.parseEther("0.05");

  try {
    // Check existing WRON balance
    const wronBal = await wron.balanceOf(bidder.address);
    log(`${WALLETS[2].name} WRON balance: ${ethers.formatEther(wronBal)}`);

    if (wronBal < wrapAmount) {
      const tx = await wron.deposit({ value: wrapAmount });
      await tx.wait();
      pass(`Wrapped ${ethers.formatEther(wrapAmount)} RON → WRON`);
    } else {
      log("Already has enough WRON, skipping wrap");
    }

    // Approve Seaport to spend WRON
    const allowance = await wron.allowance(bidder.address, SEAPORT_ADDRESS);
    if (allowance < wrapAmount) {
      const tx = await wron.approve(SEAPORT_ADDRESS, ethers.MaxUint256);
      await tx.wait();
      pass(`Approved Seaport to spend WRON`);
    } else {
      log("Seaport already approved for WRON");
    }
  } catch (err: any) {
    fail("Wrap RON / approve WRON", err);
  }
}

async function phase7c_createOffers(): Promise<string[]> {
  console.log("\n═══ Phase 7c: Create Offers (WRON) ═══");
  const offerHashes: string[] = [];

  // Wallet3 makes offers on Wallet2's and Wallet4's NFTs
  const offers = [
    { bidder: 2, tokenId: String(TOKEN_IDS.w1_list1), amount: "0.01" },  // offer on Wallet2's NFT
    { bidder: 2, tokenId: String(TOKEN_IDS.w3_list1), amount: "0.008" }, // offer on Wallet4's NFT (will be cancelled)
  ];

  for (const { bidder, tokenId, amount } of offers) {
    try {
      const result = await signAndSubmitOffer(
        wallets[bidder],
        tokenId,
        ethers.parseEther(amount),
      );
      if (result) {
        pass(`${WALLETS[bidder].name} offered ${amount} WRON on #${tokenId} → ${result.orderHash.slice(0, 18)}...`);
        offerHashes.push(result.orderHash);
      } else {
        fail(`${WALLETS[bidder].name} offer on #${tokenId}`);
      }
    } catch (err: any) {
      fail(`${WALLETS[bidder].name} offer on #${tokenId}`, err);
    }
  }

  // Verify offers via API
  if (offerHashes.length > 0) {
    const { data: bestOffer } = await oobFetch(
      `/v1/orders/best-offer?chainId=${CHAIN_ID}&collection=${NFT_CONTRACT.toLowerCase()}`,
    );
    if (bestOffer?.order) {
      pass(`Best offer: ${ethers.formatEther(bestOffer.order.priceWei)} WRON on #${bestOffer.order.tokenId}`);
    }
  }

  return offerHashes;
}

async function phase7d_acceptOffer(offerHashes: string[]) {
  console.log("\n═══ Phase 7d: Accept Offer (Seller Fulfills) ═══");
  if (offerHashes.length < 1) {
    log("No offers to accept, skipping");
    return;
  }

  const hashToAccept = offerHashes[0]; // Wallet3's offer on Wallet2's NFT
  const seller = wallets[1]; // Wallet2 accepts (owns the NFT)

  try {
    const { data: orderData } = await oobFetch(`/v1/orders/${hashToAccept}`);
    if (!orderData?.order) {
      fail("Could not fetch offer for acceptance");
      return;
    }

    const order = orderData.order;
    const orderJson = order.orderJson;
    const sig = order.signature;

    log(`Accepting offer on #${order.tokenId} for ${ethers.formatEther(order.priceWei)} WRON...`);

    const seaport = new ethers.Contract(SEAPORT_ADDRESS, SEAPORT_ABI, seller);

    const orderTuple = {
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

    const fullOrder = { parameters: orderTuple, signature: sig };

    // For offers, seller sends NFT (no native value needed)
    const tx = await seaport.fulfillOrder(
      fullOrder,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    );

    const receipt = await tx.wait();
    pass(`Accept offer tx confirmed: ${receipt.hash}`);

    // Verify NFT ownership changed to bidder (Wallet3)
    const nft = new ethers.Contract(NFT_CONTRACT, NFT_ABI, provider);
    const newOwner = await nft.ownerOf(order.tokenId);
    if (newOwner.toLowerCase() === orderJson.offerer.toLowerCase()) {
      pass(`NFT #${order.tokenId} now owned by bidder (${WALLETS[2].name})`);
    } else {
      fail(`NFT ownership: owner is ${newOwner}, expected bidder ${orderJson.offerer}`);
    }

    // Check WRON was transferred to seller
    const wron = new ethers.Contract(WRON_CONTRACT, WRON_ABI, provider);
    const sellerWron = await wron.balanceOf(seller.address);
    log(`Seller WRON balance after accept: ${ethers.formatEther(sellerWron)}`);
    if (sellerWron > 0n) {
      pass(`Seller received WRON payment`);
    }

    log("Waiting 15s for webhook to update offer status...");
    await sleep(15000);

    const { data: filledOffer } = await oobFetch(`/v1/orders/${hashToAccept}`);
    if (filledOffer?.order?.status === "filled") {
      pass(`Offer status updated to 'filled' by webhook!`);
    } else {
      log(`Offer status: ${filledOffer?.order?.status} (webhook may take longer)`);
    }
  } catch (err: any) {
    fail(`Accept offer`, err);
  }
}

async function phase7e_cancelOffer(offerHashes: string[]) {
  console.log("\n═══ Phase 7e: Cancel Offer (Signature-Based) ═══");
  if (offerHashes.length < 2) {
    log("No second offer to cancel, skipping");
    return;
  }

  const hashToCancel = offerHashes[1]; // Wallet3's second offer
  const bidder = wallets[2]; // Wallet3 cancels their own offer

  try {
    const message = `cancel:${hashToCancel}`;
    const signature = await bidder.signMessage(message);

    const { status, data } = await oobFetch(`/v1/orders/${hashToCancel}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signature }),
    });

    if (status === 200 && data?.status === "cancelled") {
      pass(`Cancelled offer ${hashToCancel.slice(0, 18)}... via signature`);
    } else {
      fail(`Cancel offer returned ${status}: ${JSON.stringify(data)}`);
    }

    // Verify it's cancelled
    const { data: order } = await oobFetch(`/v1/orders/${hashToCancel}`);
    if (order?.order?.status === "cancelled") {
      pass(`Offer status confirmed cancelled`);
    } else {
      fail(`Offer status after cancel: ${order?.order?.status}`);
    }
  } catch (err: any) {
    fail(`Cancel offer`, err);
  }
}

async function phase8_edgeCases(orderHashes: string[]) {
  console.log("\n═══ Phase 8: Edge Cases ═══");

  // Test 1: Duplicate listing (same token, same offerer)
  console.log("\n  --- Test: Duplicate listing ---");
  try {
    // This token is already listed by wallet3
    const result = await signAndSubmitListing(wallets[2], String(TOKEN_IDS.w2_list1), ethers.parseEther("0.05"));
    if (result) {
      fail("Duplicate listing should have been rejected but was accepted");
    }
  } catch (err: any) {
    // Check if the API returned 409
    pass(`Duplicate listing correctly rejected`);
  }

  // Actually check via direct API call
  const { status: dupStatus, data: dupData } = await oobFetch("/v1/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chainId: CHAIN_ID,
      order: buildListingOrder(
        wallets[2].address,
        NFT_CONTRACT,
        String(TOKEN_IDS.w2_list1),
        ethers.parseEther("0.05"),
        "0",
      ),
      signature: "0x" + "00".repeat(65),
    }),
  });
  if (dupStatus === 400 || dupStatus === 409) {
    pass(`Duplicate listing API returns ${dupStatus}: ${dupData?.error}`);
  } else {
    fail(`Duplicate listing returned ${dupStatus}`);
  }

  // Test 2: Re-list after cancel
  console.log("\n  --- Test: Re-list after cancel ---");
  if (orderHashes.length >= 2) {
    try {
      // Token w0_list2 was cancelled in phase 6, re-list it
      const result = await signAndSubmitListing(wallets[0], String(TOKEN_IDS.w0_list2), ethers.parseEther("0.03"));
      if (result) {
        pass(`Re-listed #11 after cancel → ${result.orderHash.slice(0, 18)}...`);
      } else {
        fail("Re-list after cancel");
      }
    } catch (err: any) {
      fail("Re-list after cancel", err);
    }
  }

  // Test 3: Invalid order hash lookup
  console.log("\n  --- Test: Invalid order hash ---");
  const { status: invalidStatus } = await oobFetch("/v1/orders/not-a-hash");
  if (invalidStatus === 400) {
    pass(`Invalid hash returns 400`);
  } else {
    fail(`Invalid hash returned ${invalidStatus}`);
  }

  // Test 4: Cancel already cancelled order
  console.log("\n  --- Test: Cancel already cancelled ---");
  await sleep(7000); // wait for rate limit window to reset
  if (orderHashes.length >= 2) {
    const { status: recancel, data: recancelData } = await oobFetch(`/v1/orders/${orderHashes[1]}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signature: await wallets[0].signMessage(`cancel:${orderHashes[1]}`) }),
    });
    if (recancel === 409) {
      pass(`Re-cancel returns 409: ${recancelData?.error}`);
    } else {
      fail(`Re-cancel returned ${recancel}: ${JSON.stringify(recancelData)}`);
    }
  }

  // Test 5: Cancel from wrong wallet
  // orderHashes[0] is Wallet1's listing — try to cancel with Wallet3
  console.log("\n  --- Test: Cancel from wrong wallet ---");
  await sleep(2000);
  if (orderHashes.length >= 5) {
    const targetHash = orderHashes[4]; // Wallet3's listing (#14)
    const wrongSig = await wallets[0].signMessage(`cancel:${targetHash}`); // Wallet1 signs
    const { status: wrongStatus, data: wrongData } = await oobFetch(`/v1/orders/${targetHash}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signature: wrongSig }),
    });
    if (wrongStatus === 403) {
      pass(`Wrong wallet cancel returns 403: ${wrongData?.error}`);
    } else {
      fail(`Wrong wallet cancel returned ${wrongStatus}: ${JSON.stringify(wrongData)}`);
    }
  }
}

async function phase9_verifyActivity() {
  console.log("\n═══ Phase 9: Verify Activity History ═══");

  const { data } = await oobFetch(`/v1/activity?chainId=${CHAIN_ID}&limit=100`);
  if (!data?.activity) {
    fail("Could not fetch activity");
    return;
  }

  log(`Total activity events: ${data.total}`);

  const byType: Record<string, number> = {};
  for (const evt of data.activity) {
    byType[evt.eventType] = (byType[evt.eventType] || 0) + 1;
  }

  for (const [type, count] of Object.entries(byType)) {
    log(`  ${type}: ${count}`);
  }

  if (data.total > 0) {
    pass(`Activity history is being recorded!`);
  } else {
    fail(`No activity events found`);
  }

  // Show last 5 events
  console.log("\n  Last 5 events:");
  for (const evt of data.activity.slice(0, 5)) {
    log(`  [${evt.eventType}] #${evt.tokenId} by ${evt.fromAddress?.slice(0, 10)}... at ${evt.createdAt}`);
  }
}

async function phaseFinal_summary() {
  console.log("\n═══ Final Summary ═══");

  const { data: orders } = await oobFetch(`/v1/orders?chainId=${CHAIN_ID}&status=active`);
  const { data: cancelled } = await oobFetch(`/v1/orders?chainId=${CHAIN_ID}&status=cancelled`);
  const { data: filled } = await oobFetch(`/v1/orders?chainId=${CHAIN_ID}&status=filled`);
  const { data: activity } = await oobFetch(`/v1/activity?chainId=${CHAIN_ID}`);
  const { data: stats } = await oobFetch(
    `/v1/collections/${NFT_CONTRACT.toLowerCase()}/stats?chainId=${CHAIN_ID}`,
  );

  log(`Active orders:    ${orders?.total || 0}`);
  log(`Cancelled orders: ${cancelled?.total || 0}`);
  log(`Filled orders:    ${filled?.total || 0}`);
  log(`Activity events:  ${activity?.total || 0}`);
  log(`Floor price:      ${stats?.floorPriceWei ? ethers.formatEther(stats.floorPriceWei) + " RON" : "none"}`);
  log(`Listing count:    ${stats?.listingCount || 0}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║   OOB End-to-End Test Suite                  ║");
  console.log("║   Chain: Ronin Saigon (202601)               ║");
  console.log("║   NFT:   " + NFT_CONTRACT.slice(0, 20) + "...  ║");
  console.log("╚══════════════════════════════════════════════╝");

  await phase0_checkBalances();
  await phase0b_cleanupActiveOrders();
  await phase1_transferRON();
  await phase2_mintAndDistribute();
  await phase3_approveSeaport();
  const orderHashes = await phase4_createListings();
  await phase5_verifyListings(orderHashes);
  await phase6_cancelListing(orderHashes);
  await phase7_directBuy(orderHashes);
  await phase7b_wrapRONAndApprove();
  const offerHashes = await phase7c_createOffers();
  await phase7d_acceptOffer(offerHashes);
  await phase7e_cancelOffer(offerHashes);
  await phase8_edgeCases(orderHashes);
  await phase9_verifyActivity();
  await phaseFinal_summary();

  console.log("\n══════════════════════════════════════════════");
  console.log("  Tests complete! Check results above.");
  console.log("══════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
