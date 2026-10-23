// Shared by the sandboxed browser renderer and deterministic Node tests.
(() => {
  class LibraryUpdates {
    constructor({ snapshot, loadSnapshot, onChange, onError = () => {}, schedule = fn => setTimeout(fn, 0) }) {
      this.loadSnapshot = loadSnapshot;
      this.onChange = onChange;
      this.onError = onError;
      this.schedule = schedule;
      this.pending = [];
      this.scheduled = false;
      this.flushing = false;
      this.needsSnapshot = false;
      this.revision = 0;
      this.replaceSnapshot(snapshot);
    }
    version(value) {
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
    replaceSnapshot(snapshot) {
      if (!snapshot || !Array.isArray(snapshot.games)) throw Error('Invalid library snapshot.');
      this.games = snapshot.games.slice();
      this.byId = new Map(this.games.map(game => [game.id, game]));
      this.runningIds = Array.isArray(snapshot.runningIds) ? snapshot.runningIds : [];
      this.revision = this.version(snapshot.revision) ?? this.revision;
    }
    snapshot() {
      return { games:this.games, runningIds:this.runningIds, revision:this.revision };
    }
    receive(event) {
      const version = this.version(event.revision);
      if (version !== null && version <= this.revision) return;
      this.pending.push(event);
      if (!this.scheduled && !this.flushing) {
        this.scheduled = true;
        this.schedule(() => this.flush());
      }
    }
    requiresSnapshot(batch) {
      let revision = this.revision;
      if (this.needsSnapshot) return true;
      for (const event of batch) {
        const version = this.version(event.revision);
        if (version !== null && version <= revision) continue;
        if (!Array.isArray(event.games) && !Array.isArray(event.removedIds)) return true;
        if (version !== null) {
          if (version !== revision + 1) return true;
          revision = version;
        }
      }
      return false;
    }
    async flush() {
      if (this.flushing) return;
      this.scheduled = false;
      this.flushing = true;
      const changedIds = new Set();
      const removedIds = new Set();
      let gamesChanged = false;
      let runningChanged = false;
      let reset = false;
      try {
        while (this.pending.length) {
          let batch = this.pending.splice(0);
          if (this.requiresSnapshot(batch)) {
            const snapshot = await this.loadSnapshot();
            this.replaceSnapshot(snapshot);
            this.needsSnapshot = false;
            reset = true;
            gamesChanged = true;
            runningChanged = true;
            // A versioned snapshot covers queued older events. A legacy snapshot
            // covers the entire batch that existed before the read was started.
            const watermark = this.version(snapshot.revision);
            batch = watermark === null ? [] : batch.filter(event =>
              this.version(event.revision) !== null && event.revision > watermark);
          }
          for (const event of batch) {
            const version = this.version(event.revision);
            if (version !== null && version <= this.revision) continue;
            for (const game of event.games || []) {
              if (!game || typeof game.id !== 'string') continue;
              const previous = this.byId.get(game.id);
              if (previous && JSON.stringify(previous) === JSON.stringify(game)) continue;
              this.byId.set(game.id, game);
              changedIds.add(game.id);
              removedIds.delete(game.id);
              gamesChanged = true;
            }
            for (const id of event.removedIds || []) {
              if (!this.byId.delete(id)) continue;
              removedIds.add(id);
              changedIds.delete(id);
              gamesChanged = true;
            }
            if (Array.isArray(event.runningIds) &&
                JSON.stringify(event.runningIds) !== JSON.stringify(this.runningIds)) {
              this.runningIds = event.runningIds;
              runningChanged = true;
            }
            if (version !== null) this.revision = version;
          }
        }
      } catch (error) {
        // Do not spin on a failed IPC request; recover on the next change event.
        this.needsSnapshot = true;
        this.onError(error);
      } finally {
        this.flushing = false;
        if (gamesChanged) this.games = [...this.byId.values()];
        if (gamesChanged || runningChanged || reset) {
          this.onChange({ ...this.snapshot(), changedIds:[...changedIds], removedIds:[...removedIds], reset });
        }
        if (this.pending.length && !this.scheduled) {
          this.scheduled = true;
          this.schedule(() => this.flush());
        }
      }
    }
  }
  const api = Object.freeze({ LibraryUpdates });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.OrbitLibraryUpdates = api;
})();
