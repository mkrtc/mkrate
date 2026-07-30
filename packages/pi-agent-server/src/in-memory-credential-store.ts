import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';

/**
 * Process-local credential storage for the Pi subprocess.
 *
 * The main process remains the persistence owner and pushes refreshed tokens over
 * JSONL. Per-provider writes are serialized because Pi may refresh an OAuth
 * credential concurrently with a token_update message.
 */
export class InMemoryCredentialStore implements CredentialStore {
  private readonly credentials = new Map<string, Credential>();
  private readonly writeQueues = new Map<string, Promise<void>>();

  async read(providerId: string): Promise<Credential | undefined> {
    return this.credentials.get(providerId);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return [...this.credentials].map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.runSerialized(providerId, async () => {
      const next = await fn(this.credentials.get(providerId));
      if (next !== undefined) {
        this.credentials.set(providerId, next);
      }
      return this.credentials.get(providerId);
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.runSerialized(providerId, async () => {
      this.credentials.delete(providerId);
    });
  }

  async set(providerId: string, credential: Credential): Promise<void> {
    await this.modify(providerId, async () => credential);
  }

  private async runSerialized<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(providerId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(() => undefined, () => undefined);
    this.writeQueues.set(providerId, tail);

    try {
      return await current;
    } finally {
      if (this.writeQueues.get(providerId) === tail) {
        this.writeQueues.delete(providerId);
      }
    }
  }
}
