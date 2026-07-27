import { BrokerError } from '../core/broker.js';
import type { Broker } from '../core/broker.js';
import { PositionMirror } from '../core/mirror.js';
import type { Instrument, OrderRequest } from '../core/types.js';
import { BROKER_SCENARIOS } from './scenarios.js';

export interface BrokerConformanceHarness {
  broker: Broker;
  instrument: Instrument;
  setPosition(qty: number): void | Promise<void>;
  /** Set opposing venue positions when supported; otherwise the suite uses their signed net. */
  setHedgedPositions?(longQty: number, shortQty: number): void | Promise<void>;
  rejectNext(message: string): void;
  mark(price: number, time: number): void | Promise<void>;
  orders?: readonly OrderRequest[];
}

export interface ConformanceFailure {
  scenario: string;
  message: string;
}

/** Framework-neutral shared suite. Real adapters run it against a controllable mock/sandbox transport. */
export async function runBrokerConformance(
  makeHarness: () => BrokerConformanceHarness | Promise<BrokerConformanceHarness>,
): Promise<ConformanceFailure[]> {
  const failures: ConformanceFailure[] = [];
  for (let index = 0; index < BROKER_SCENARIOS.length; index++) {
    const scenario = BROKER_SCENARIOS[index]!;
    const harness = await makeHarness();
    await harness.mark(100, 1_700_000_000 + index);
    if (scenario.name.startsWith('hedging net')) {
      if (
        harness.broker.capabilities().positionModel === 'hedging' &&
        !harness.setHedgedPositions
      ) {
        failures.push({
          scenario: scenario.name,
          message: 'hedging adapter must expose opposing positions through setHedgedPositions',
        });
        continue;
      }
      if (harness.setHedgedPositions) await harness.setHedgedPositions(3, 2);
      else await harness.setPosition(1);
    } else {
      await harness.setPosition(scenario.actual);
    }
    const mirror = new PositionMirror(harness.broker, harness.instrument);
    const outcome = await mirror.reconcile(scenario.target, {
      symbol: harness.instrument.symbol,
      barTime: 1_700_000_000 + index,
      strategyId: 'conformance',
      timeframe: '1m',
      sequence: index,
    });
    if (scenario.expectedSide == null) {
      if (outcome.action !== 'noop')
        failures.push({ scenario: scenario.name, message: `expected noop, got ${outcome.action}` });
    } else if (outcome.action !== 'order') {
      failures.push({ scenario: scenario.name, message: `expected order, got ${outcome.action}` });
    } else {
      if (outcome.order.side !== scenario.expectedSide)
        failures.push({
          scenario: scenario.name,
          message: `expected ${scenario.expectedSide}, got ${outcome.order.side}`,
        });
      if (outcome.order.qty !== scenario.expectedQty)
        failures.push({
          scenario: scenario.name,
          message: `expected qty ${scenario.expectedQty}, got ${outcome.order.qty}`,
        });
      const final = await harness.broker.getPosition(harness.instrument.symbol);
      if (final.qty !== scenario.target)
        failures.push({
          scenario: scenario.name,
          message: `expected final ${scenario.target}, got ${final.qty}`,
        });
    }
  }

  const rejection = await makeHarness();
  await rejection.mark(100, 1_700_001_000);
  await rejection.setPosition(0);
  rejection.rejectNext('conformance rejection');
  const rejected = await new PositionMirror(rejection.broker, rejection.instrument).reconcile(1, {
    symbol: rejection.instrument.symbol,
    barTime: 1_700_001_000,
    strategyId: 'conformance-reject',
    timeframe: '1m',
    sequence: BROKER_SCENARIOS.length,
  });
  if (rejected.action !== 'reject' || rejected.error.code !== 'reject') {
    failures.push({
      scenario: 'reject',
      message: `expected classified reject, got ${rejected.action}`,
    });
  }
  if ((await rejection.broker.getPosition(rejection.instrument.symbol)).qty !== 0) {
    failures.push({ scenario: 'reject', message: 'rejected order changed net position' });
  }

  const idempotency = await makeHarness();
  await idempotency.mark(100, 1_700_002_000);
  await idempotency.setPosition(0);
  const request: OrderRequest = {
    symbol: idempotency.instrument.symbol,
    side: 'buy',
    qty: idempotency.instrument.minQty,
    type: 'market',
    clientId: 'conformance:idempotency',
  };
  const first = await idempotency.broker.submit(request);
  const duplicate = await idempotency.broker.submit(request);
  const afterDuplicate = await idempotency.broker.getPosition(idempotency.instrument.symbol);
  if (first.brokerOrderId !== duplicate.brokerOrderId || afterDuplicate.qty !== request.qty) {
    failures.push({
      scenario: 'idempotency',
      message: 'duplicate client id booked more than once',
    });
  }
  try {
    await idempotency.broker.submit({ ...request, side: 'sell' });
    failures.push({
      scenario: 'idempotency conflict',
      message: 'conflicting payload under one client id was accepted',
    });
  } catch (error) {
    if (!(error instanceof BrokerError) || error.code !== 'precondition') {
      failures.push({
        scenario: 'idempotency conflict',
        message: 'conflicting payload did not produce a precondition BrokerError',
      });
    }
  }

  const restart = await makeHarness();
  await restart.mark(100, 1_700_003_000);
  await restart.setPosition(0);
  const step = restart.instrument.qtyStep ?? restart.instrument.minQty;
  const restartIds = new Set<string>();
  for (let process = 0; process < 3; process++) {
    const outcome = await new PositionMirror(restart.broker, restart.instrument, {
      maxOrderQty: step * 2,
    }).reconcile(step * 5, {
      symbol: restart.instrument.symbol,
      barTime: 1_700_003_000,
      strategyId: 'conformance-restart-cap',
      timeframe: '1m',
      sequence: 0,
    });
    if (outcome.action !== 'order') {
      failures.push({
        scenario: 'same-bar capped restart',
        message: `expected order on process ${process + 1}, got ${outcome.action}`,
      });
      break;
    }
    restartIds.add(outcome.order.clientId);
  }
  const restartPosition = await restart.broker.getPosition(restart.instrument.symbol);
  if (restartPosition.qty !== step * 5 || restartIds.size !== 3) {
    failures.push({
      scenario: 'same-bar capped restart',
      message: `expected restart progression to ${step * 5} with 3 ids, got ${restartPosition.qty} with ${restartIds.size}`,
    });
  }

  return failures;
}
