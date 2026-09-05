// Shared config + helpers for both pages. No build step, no bundler — this is
// a two-day hackathon demo, and one plain script loaded by two plain HTML
// files is less to get wrong than a toolchain would be.

const API = ""; // same origin as the page — server.js serves both

const CONTRACT = "0x3C978900248E7180593fCb3dB97Ce6F1BE7A1908";
const TOKEN = "0xD0662CA1a427Aee7c302CA2265637fEf814528EE";
const CHAIN_ID_HEX = "0x14a34"; // Base Sepolia, 84532
const EXPLORER = "https://sepolia.basescan.org";

const GUARD_ABI = [
  "function buyPolicy(bytes32 place, int32 thresholdMilliC, bool payAbove, uint96 premium, uint64 expiry) returns (uint256)",
  "function policyCount() view returns (uint256)",
  "function policies(uint256) view returns (address holder, uint96 premium, uint96 payout, bytes32 place, int32 thresholdMilliC, bool payAbove, uint64 expiry, uint8 status)",
  "function toleranceMilliC() view returns (uint32)",
  "function freeLiquidity() view returns (uint256)",
  "event PolicyBought(uint256 indexed id, address indexed holder, bytes32 indexed place, int32 thresholdMilliC, bool payAbove, uint96 premium, uint96 payout, uint64 expiry)",
];

const TOKEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function mint(address,uint256)",
];

const PLACES = [
  { key: "cairo", name: "Cairo" },
  { key: "lagos", name: "Lagos" },
  { key: "london", name: "London" },
  { key: "singapore", name: "Singapore" },
  { key: "reykjavik", name: "Reykjavik" },
];

const usd = (raw) => "$" + (Number(raw) / 1e6).toFixed(2);
const c1 = (n) => (n === null || n === undefined ? "N/A" : Number(n).toFixed(1) + "°C");
const short = (addr) => addr.slice(0, 6) + "…" + addr.slice(-4);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const txLink = (hash) => `${EXPLORER}/tx/${hash}`;
const addrLink = (addr) => `${EXPLORER}/address/${addr}`;

async function api(path, opts) {
  const res = await fetch(API + path, opts);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `request failed: ${res.status}`);
  return body;
}

/** Connect the injected wallet (MetaMask/Coinbase Wallet/Rabby/etc) and make
 *  sure it's on Base Sepolia — adding the chain if the wallet doesn't know it
 *  yet, since a testnet chain is rarely pre-configured. */
async function connectWallet() {
  if (!window.ethereum) throw new Error("No wallet found. Install MetaMask or another browser wallet.");
  const provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);

  const network = await provider.getNetwork();
  if ("0x" + network.chainId.toString(16) !== CHAIN_ID_HEX) {
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] });
    } catch (switchErr) {
      if (switchErr.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: CHAIN_ID_HEX,
            chainName: "Base Sepolia",
            nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://sepolia.base.org"],
            blockExplorerUrls: [EXPLORER],
          }],
        });
      } else {
        throw switchErr;
      }
    }
  }

  const signer = await provider.getSigner();
  return { provider, signer, address: await signer.getAddress() };
}
