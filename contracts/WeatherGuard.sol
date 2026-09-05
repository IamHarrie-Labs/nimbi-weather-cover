// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * WeatherGuard — testnet demonstration of Telegraph intelligence settling on-chain.
 *
 * A holder buys cover against a temperature threshold at a place. An off-chain
 * agent reads that temperature from several independent Telegraph miners,
 * cross-checks them, and reports the result here. If the miners agree and the
 * threshold was breached, this contract pays out. If the miners disagree
 * beyond tolerance, it refuses to settle and records why.
 *
 * The refusal is the point. A single oracle reading cannot tell you whether it
 * is trustworthy; several independent readings can. Every settlement attempt
 * is recorded with the number of miners consulted, the median they agreed on,
 * and how far apart they were — so anyone can audit not just what was paid,
 * but what evidence justified it.
 *
 * NOT INSURANCE. Testnet only, play money, no risk transfer, no underwriting.
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract WeatherGuard {
    // ---------------------------------------------------------------- types

    enum Status {
        Open,      // live, awaiting a settlement attempt
        PaidOut,   // threshold breached under miner agreement
        Expired,   // ran to expiry without a qualifying breach
        Refunded   // cancelled before expiry by the holder
    }

    /**
     * Temperatures are carried as milli-degrees Celsius (27_900 = 27.9C) so the
     * chain never sees a float. Signed, because sub-zero thresholds are real.
     */
    struct Policy {
        address holder;
        uint96  premium;        // paid in the settlement token, 6 decimals
        uint96  payout;         // owed on a qualifying breach
        bytes32 place;          // short name, e.g. "cairo"
        int32   thresholdMilliC;
        bool    payAbove;       // true: pay if temp >= threshold; false: <=
        uint64  expiry;         // unix seconds
        Status  status;
    }

    /** What the agent observed on one settlement attempt. */
    struct Attestation {
        uint64 observedAt;
        int32  medianMilliC;
        uint32 spreadMilliC;    // max - min across miners
        uint16 minersAgreeing;
        uint16 minersTotal;
        bool   settled;         // false when held for disagreement
    }

    // --------------------------------------------------------------- errors

    error NotOwner();
    error NotAgent();
    error NotHolder();
    error PolicyClosed();
    error PolicyExpired();
    error PolicyNotExpired();
    error PremiumTooSmall();
    error PoolTooThin();
    error TransferFailed();
    error BadWindow();

    // --------------------------------------------------------------- events

    event PolicyBought(
        uint256 indexed id,
        address indexed holder,
        bytes32 indexed place,
        int32 thresholdMilliC,
        bool payAbove,
        uint96 premium,
        uint96 payout,
        uint64 expiry
    );

    /** Miners agreed and the threshold was breached. Funds moved. */
    event PaidOut(
        uint256 indexed id,
        address indexed holder,
        uint96 amount,
        int32 medianMilliC,
        uint32 spreadMilliC,
        uint16 minersAgreeing,
        uint16 minersTotal
    );

    /**
     * Miners did not agree closely enough to act on. No funds moved.
     * This is the event that proves the guard did something.
     */
    event SettlementHeld(
        uint256 indexed id,
        int32 medianMilliC,
        uint32 spreadMilliC,
        uint32 toleranceMilliC,
        uint16 minersAgreeing,
        uint16 minersTotal,
        string reason
    );

    /** Miners agreed, but the threshold was not breached. Nothing owed yet. */
    event Checked(uint256 indexed id, int32 medianMilliC, uint32 spreadMilliC, uint16 minersTotal);

    event PolicyExpiredEvent(uint256 indexed id);
    event PolicyRefunded(uint256 indexed id, address indexed holder, uint96 amount);
    event PoolFunded(address indexed from, uint256 amount);
    event AgentChanged(address indexed previous, address indexed next);
    event ToleranceChanged(uint32 previous, uint32 next);

    // ---------------------------------------------------------------- state

    IERC20 public immutable token;
    address public owner;

    /// The off-chain reader allowed to report miner consensus.
    address public agent;

    /// Largest spread between miners still considered agreement, milli-Celsius.
    uint32 public toleranceMilliC;

    /// Miners that must return a readable value before any settlement counts.
    uint16 public minMiners;

    /// Payout is this multiple of premium, in basis points. 50_000 = 5x.
    uint32 public payoutBps;

    uint96 public premiumFloor;
    uint96 public premiumCeiling;

    /// Premiums held against open policies; never lent out or paid as yield.
    uint256 public reserved;

    Policy[] public policies;
    mapping(uint256 => Attestation[]) private _attestations;

    // ------------------------------------------------------------ modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    // ---------------------------------------------------------- constructor

    constructor(address token_, address agent_) {
        token = IERC20(token_);
        owner = msg.sender;
        agent = agent_;

        toleranceMilliC = 2_000;  // 2.0C — miners routinely sit within this
        minMiners = 3;
        payoutBps = 50_000;       // 5x
        premiumFloor = 100_000;   // $0.10
        premiumCeiling = 2_000_000; // $2.00
    }

    // ------------------------------------------------------------- policies

    /**
     * Buy cover. The premium transfers in immediately and the payout is
     * reserved from the pool, so a policy can never be sold that the pool
     * cannot honour.
     */
    function buyPolicy(
        bytes32 place,
        int32 thresholdMilliC,
        bool payAbove,
        uint96 premium,
        uint64 expiry
    ) external returns (uint256 id) {
        if (premium < premiumFloor || premium > premiumCeiling) revert PremiumTooSmall();
        if (expiry <= block.timestamp || expiry > block.timestamp + 30 days) revert BadWindow();

        uint96 payout = uint96((uint256(premium) * payoutBps) / 10_000);

        // Everything already reserved is spoken for; only the surplus can back
        // a new policy.
        uint256 free = token.balanceOf(address(this)) - reserved;
        if (free + premium < payout) revert PoolTooThin();

        if (!token.transferFrom(msg.sender, address(this), premium)) revert TransferFailed();

        id = policies.length;
        policies.push(
            Policy({
                holder: msg.sender,
                premium: premium,
                payout: payout,
                place: place,
                thresholdMilliC: thresholdMilliC,
                payAbove: payAbove,
                expiry: expiry,
                status: Status.Open
            })
        );
        reserved += payout;

        emit PolicyBought(id, msg.sender, place, thresholdMilliC, payAbove, premium, payout, expiry);
    }

    /**
     * Report what the miners said.
     *
     * Called by the agent after reading the same question from several miners.
     * Three outcomes, all recorded:
     *   - no majority, too few miners, or spread beyond tolerance -> held, no funds move
     *   - agreement but no breach                                 -> checked, no funds move
     *   - agreement and breach                                    -> paid out
     */
    function reportReading(
        uint256 id,
        int32 medianMilliC,
        uint32 spreadMilliC,
        uint16 minersAgreeing,
        uint16 minersTotal
    ) external onlyAgent {
        Policy storage p = policies[id];
        if (p.status != Status.Open) revert PolicyClosed();
        if (block.timestamp > p.expiry) revert PolicyExpired();

        bool enough = minersTotal >= minMiners && minersAgreeing >= minMiners;
        bool tight = spreadMilliC <= toleranceMilliC;

        // The agent reports the spread of the miners that agreed, not of every
        // miner that answered — one reporter stuck on a constant should not
        // veto a settlement five others concur on. That concession is only
        // safe if the chain checks the agreeing side is genuinely the larger
        // one, so the majority test lives here rather than in the agent: an
        // agent that lied about which cluster won still cannot settle on it.
        bool majority = uint256(minersAgreeing) * 2 > uint256(minersTotal);

        _attestations[id].push(
            Attestation({
                observedAt: uint64(block.timestamp),
                medianMilliC: medianMilliC,
                spreadMilliC: spreadMilliC,
                minersAgreeing: minersAgreeing,
                minersTotal: minersTotal,
                settled: enough && tight && majority
            })
        );

        if (!enough || !tight || !majority) {
            emit SettlementHeld(
                id,
                medianMilliC,
                spreadMilliC,
                toleranceMilliC,
                minersAgreeing,
                minersTotal,
                // Most specific finding first. A genuine split fails every one
                // of these tests at once, so ordering decides which fact the
                // record shows — and "no majority agreed" says more than
                // "too few answered".
                !majority
                    ? "no majority of miners agreed"
                    : !tight
                        ? "miners disagree beyond tolerance"
                        : "too few miners answered to act on"
            );
            return;
        }

        bool breached = p.payAbove ? medianMilliC >= p.thresholdMilliC : medianMilliC <= p.thresholdMilliC;
        if (!breached) {
            emit Checked(id, medianMilliC, spreadMilliC, minersTotal);
            return;
        }

        uint96 amount = p.payout;
        p.status = Status.PaidOut;
        reserved -= amount;

        if (!token.transfer(p.holder, amount)) revert TransferFailed();

        emit PaidOut(id, p.holder, amount, medianMilliC, spreadMilliC, minersAgreeing, minersTotal);
    }

    /** Close a policy that ran past expiry without a qualifying breach. */
    function expirePolicy(uint256 id) external {
        Policy storage p = policies[id];
        if (p.status != Status.Open) revert PolicyClosed();
        if (block.timestamp <= p.expiry) revert PolicyNotExpired();

        p.status = Status.Expired;
        reserved -= p.payout;
        emit PolicyExpiredEvent(id);
    }

    /**
     * Holders can walk away before expiry and take their premium back.
     * Generous by design: this is a demo, and nobody should lose test funds to
     * a bug in it.
     */
    function cancelPolicy(uint256 id) external {
        Policy storage p = policies[id];
        if (msg.sender != p.holder) revert NotHolder();
        if (p.status != Status.Open) revert PolicyClosed();

        p.status = Status.Refunded;
        reserved -= p.payout;

        if (!token.transfer(p.holder, p.premium)) revert TransferFailed();
        emit PolicyRefunded(id, p.holder, p.premium);
    }

    // ----------------------------------------------------------------- pool

    function fundPool(uint256 amount) external {
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit PoolFunded(msg.sender, amount);
    }

    /** Only the surplus above reserved payouts can leave. */
    function withdrawSurplus(uint256 amount) external onlyOwner {
        uint256 free = token.balanceOf(address(this)) - reserved;
        if (amount > free) revert PoolTooThin();
        if (!token.transfer(owner, amount)) revert TransferFailed();
    }

    // ------------------------------------------------------------- settings

    function setAgent(address next) external onlyOwner {
        emit AgentChanged(agent, next);
        agent = next;
    }

    function setTolerance(uint32 next) external onlyOwner {
        emit ToleranceChanged(toleranceMilliC, next);
        toleranceMilliC = next;
    }

    function setMinMiners(uint16 next) external onlyOwner {
        minMiners = next;
    }

    // ---------------------------------------------------------------- views

    function policyCount() external view returns (uint256) {
        return policies.length;
    }

    function attestationCount(uint256 id) external view returns (uint256) {
        return _attestations[id].length;
    }

    function attestationAt(uint256 id, uint256 index) external view returns (Attestation memory) {
        return _attestations[id][index];
    }

    /** Funds not reserved against an open policy. */
    function freeLiquidity() external view returns (uint256) {
        return token.balanceOf(address(this)) - reserved;
    }
}
