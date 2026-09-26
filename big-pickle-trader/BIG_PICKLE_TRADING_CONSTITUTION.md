# Big Pickle Trading Constitution

These rules define the permanent architectural boundaries for Big Pickle's autonomous trading system.

## 1. LLMs propose; deterministic software executes

LLMs may generate structured TradeIntent proposals.

A TradeIntent may contain:
- symbol
- direction
- strategy ID
- thesis ID
- market regime
- desired entry conditions
- invalidation thesis
- suggested stop region
- suggested profit objective
- expected holding period
- expected edge in basis points
- confidence
- supporting evidence
- expiration/TTL

LLMs do not have final authority over position size, leverage, dollar risk, or exchange execution.

The deterministic Risk Engine converts an approved TradeIntent into an OrderPlan.

It independently calculates:
- stop-distance risk
- permitted position size
- maximum loss
- portfolio exposure
- correlated exposure
- leverage limits
- spread
- estimated slippage
- fees
- transaction costs
- minimum required edge
- liquidity requirements
- drawdown limits
- daily and strategy loss limits

Model-declared risk, confidence, size, and leverage are advisory only.

## 2. NO TRADE is a first-class decision

Valid router outcomes include:

TRADE
WAIT
WATCH
VETO
NO_TRADE

No strategy is required to produce a trade.

Optimize for repeatable net expectancy after costs, not trade count or win rate.

## 3. Separate intelligence from risk

Required architecture:

Market Discovery
 Regime Detection
 Competing Strategy Families
 Trade Proposal
 Adversarial Review
 Portfolio Risk Engine
 Deterministic Execution
 Monitoring
 Post-Trade Evaluation

Risk vetoes cannot be overridden by another trading model.

## 4. Model personality is not risk policy

Risk tolerance belongs to deterministic portfolio policy.

More aggressive models may generate more aggressive ideas, but all proposals pass through identical hard risk constraints.

## 5. Evaluate expectancy, not just win rate

Track at minimum:

- net expectancy per trade
- average winner
- average loser
- payoff ratio
- profit factor
- maximum drawdown
- Sharpe
- Sortino
- turnover
- fees
- spread cost
- slippage
- adverse selection
- MFE
- MAE

Win rate is descriptive, not the primary objective.

## 6. Measure tail dependence

For every model and strategy calculate:

- Top-1 Trade Contribution
- Top-3 Trade Contribution
- Top-5 Trade Contribution
- P&L excluding largest winner
- P&L excluding largest 3 winners
- P&L excluding largest 5 winners

Flag strategies whose profitability depends mainly on a few extreme winners.

Always ask:

"What happens if we remove the three best trades?"

## 7. Always run controls

Experiments must be compared against appropriate controls using identical data and cost assumptions.

Controls should include where applicable:

- cash / no trade
- buy and hold
- deterministic momentum
- deterministic mean reversion
- random entry
- random entry with identical risk/exit rules
- current production baseline

Profit alone does not demonstrate AI edge.

## 8. Run multiple trials

A single stochastic LLM backtest is not sufficient evidence.

Record:

- mean return
- median return
- standard deviation
- confidence interval
- best trial
- worst trial
- drawdown distribution
- trade-count distribution
- strategy-selection distribution

High average return with extreme run-to-run instability must be treated as unstable.

## 9. Use walk-forward and out-of-sample testing

Test across multiple market regimes:

- bull trend
- bear trend
- sideways/chop
- high volatility
- low volatility
- liquidity shocks
- weekends
- news-driven periods
- post-shock recovery

Keep development periods separate from untouched out-of-sample evaluation.

Favor out-of-sample net expectancy.

## 10. Execution simulation must be realistic

Do not assume perfect fills at candle-close prices.

Model:

- bid/ask spread
- order-book depth
- maker/taker status
- queue/fill probability
- partial fills
- cancel/replace behavior
- latency
- missed orders
- price movement during latency
- slippage
- adverse selection
- exchange fees

Record both:

DECISION PRICE
REALIZED FILL PRICE

Coinbase Advanced testing must use Coinbase-specific costs and market structure.

## 11. Expected edge must exceed expected cost

Before execution:

expected_edge_bps >
fees
+ spread
+ expected_slippage
+ latency/adverse-selection buffer
+ safety margin

If this condition is not met, veto the trade.

Minimum required edge should adjust dynamically with liquidity and volatility.

## 12. Maker and taker execution are distinct strategies

The execution engine decides between:

- passive maker
- aggressive maker repricing
- marketable limit
- taker execution
- abandoning the opportunity

The LLM does not receive automatic taker authority.

## 13. Maintain an immutable event ledger

For every evaluated opportunity record:

- timestamp
- market snapshot
- raw data references
- market regime
- strategy
- model/version
- prompt/config version
- proposal
- expected edge
- confidence
- TradeIntent
- risk calculations
- risk modifications
- veto reason
- OrderPlan
- submission timestamp
- exchange order ID
- fill events
- partial fills
- latency
- requested price
- average fill price
- fees
- spread estimate
- slippage
- position changes
- exit reason
- realized P&L
- MFE
- MAE

Rejected and NO_TRADE opportunities must also be logged.

## 14. Separate decision quality from outcome quality

After every closed trade evaluate:

- Was the predicted setup actually present?
- Was regime classification correct?
- Was expected edge realistic?
- Was entry quality good?
- Was execution quality good?
- Was sizing correct?
- Was exit policy followed?
- Was the result primarily luck?
- Would the thesis still be considered sound if the outcome reversed?
- What happened after rejected opportunities?

A good decision may lose.
A bad decision may win.

Do not train the router to confuse P&L with decision quality.

## 15. Calibrate confidence

A model reporting confidence = 0.80 does not automatically imply an 80% success probability.

Maintain empirical calibration histories by:

- model
- strategy
- regime
- asset
- confidence bucket

Use realized calibration when determining router weight.

## 16. Learning may modify weights, not safety rules

Post-trade learning may recommend:

- changing strategy weights
- changing regime confidence
- adjusting signal thresholds
- proposing new hypotheses

It may NOT autonomously weaken:

- maximum loss
- drawdown limits
- position limits
- cost requirements
- liquidity requirements
- circuit breakers
- execution safeguards

Risk policy remains deterministic and version controlled.

## 17. Keep the number of true LLM brains small

Use deterministic software where deterministic software is appropriate.

Deterministic services should handle:

- data ingestion
- indicators
- screening
- cost calculations
- risk
- order management
- portfolio accounting
- logging
- statistics
- monitoring

Reserve LLM reasoning for interpretation, competing hypotheses, contextual reasoning, and strategy analysis.

## 18. Primary objective

Big Pickle's primary objective is:

Maximize repeatable net expectancy after all real transaction costs while keeping drawdown and tail risk within predefined limits.

The objective is NOT:

- highest win rate
- most trades
- highest gross P&L
- best profit screenshot
- most confident model

Every strategy and model must earn continued router allocation through out-of-sample evidence.

## Amendment A — Aggressive Alpha Mandate

Big Pickle should pursue validated alpha aggressively.

Risk controls exist to protect capital and permit intelligent aggression, not to minimize trading activity.

When statistically supported net edge materially exceeds costs and risk requirements, the router should be capable of increasing strategy allocation within deterministic portfolio limits.

The system should aggressively explore in simulation and paper trading, rapidly promote repeatable out-of-sample edge, and rapidly reduce or eliminate allocation to strategies whose edge deteriorates.

Aggression belongs in discovery, experimentation, competition between strategies, and exploitation of validated edge.

Aggression does not override deterministic risk limits, execution safeguards, drawdown controls, or circuit breakers.

## Core architectural boundary

TradeIntent and OrderPlan are separate objects.

LLM
 TradeIntent
 Router
 Risk Engine
 OrderPlan
 Execution Engine
 Exchange

The LLM must never have a direct path to exchange order submission.

## Alpha Arena lesson

Never accept a model's statement of risk as truth.

Actual risk must be independently calculated from entry price, stop price, position quantity, fees, slippage, and other applicable exposure.

Never judge a strategy solely by headline profit.

Always measure whether the result survives removal of its largest one, three, and five winning trades.
