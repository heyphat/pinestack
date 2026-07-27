import { expect, test } from 'bun:test';
import { PaperBroker } from '../src/index.js';
import { runBrokerConformance } from '../src/testing/index.js';

const instrument = { symbol: 'X', minQty: 1, mintick: 0.01 };

test('PaperBroker passes shared broker conformance', async () => {
  let rejection: string | undefined;
  const failures = await runBrokerConformance(() => {
    rejection = undefined;
    const broker = new PaperBroker({ instruments: { X: instrument }, reject: () => rejection });
    return {
      broker,
      instrument,
      setPosition: (qty: number) => broker.setPosition('X', qty, 100),
      rejectNext: (message: string) => {
        rejection = message;
      },
      mark: (price: number, time: number) => broker.mark('X', price, time),
    };
  });
  expect(failures).toEqual([]);
});
