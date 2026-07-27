import { BrokerError } from './broker.js';
import type { Broker } from './broker.js';

export interface BrokerFactoryContext {
  /** Real adapters must receive and independently enforce this flag. */
  armed: boolean;
  config?: Readonly<Record<string, unknown>>;
  env?: Readonly<Record<string, string | undefined>>;
}

export type BrokerFactory = (context: BrokerFactoryContext) => Broker | Promise<Broker>;

export interface BrokerRegistration {
  factory: BrokerFactory;
  /** Marks an adapter capable of real execution. Registry refuses to construct it unless armed. */
  real: boolean;
}

export class BrokerRegistry {
  private readonly registrations = new Map<string, BrokerRegistration>();

  register(id: string, registration: BrokerRegistration): this {
    if (!id || this.registrations.has(id)) throw new Error(`broker already registered: ${id}`);
    this.registrations.set(id, registration);
    return this;
  }

  has(id: string): boolean {
    return this.registrations.has(id);
  }

  ids(): string[] {
    return [...this.registrations.keys()].sort();
  }

  async create(id: string, context: BrokerFactoryContext): Promise<Broker> {
    const registration = this.registrations.get(id);
    if (!registration) throw new BrokerError('precondition', `unknown broker adapter "${id}"`);
    if (registration.real && !context.armed) {
      throw new BrokerError('precondition', `real broker "${id}" requires explicit arming`);
    }
    const broker = await registration.factory(context);
    if (registration.real && !context.armed)
      throw new BrokerError('precondition', 'real broker was not armed');
    return broker;
  }
}
