export interface BrokerScenario {
  name: string;
  actual: number;
  target: number;
  expectedSide?: 'buy' | 'sell';
  expectedQty?: number;
}

export const BROKER_SCENARIOS: readonly BrokerScenario[] = [
  { name: 'noop', actual: 0, target: 0 },
  { name: 'open long', actual: 0, target: 2, expectedSide: 'buy', expectedQty: 2 },
  { name: 'add long', actual: 1, target: 3, expectedSide: 'buy', expectedQty: 2 },
  { name: 'reduce long', actual: 3, target: 1, expectedSide: 'sell', expectedQty: 2 },
  { name: 'close long', actual: 2, target: 0, expectedSide: 'sell', expectedQty: 2 },
  { name: 'flip long to short', actual: 2, target: -1, expectedSide: 'sell', expectedQty: 3 },
  {
    name: 'hedging net (3 long, 2 short)',
    actual: 1,
    target: -1,
    expectedSide: 'sell',
    expectedQty: 2,
  },
  { name: 'restart drift correction', actual: -2, target: 1, expectedSide: 'buy', expectedQty: 3 },
];
