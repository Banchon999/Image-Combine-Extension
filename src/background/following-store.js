import { FOLLOW_KEY, MAX_FOLLOWED, createFollowEntry, followId, updateFollowEntry,
  markHandled, parseFollowBackup } from '../common/following.js';

/** Single-writer queue prevents concurrent checks/adds/imports losing updates. */
export function createFollowingStore(storage, { now = Date.now, token = () => crypto.randomUUID() } = {}) {
  let tail = Promise.resolve();
  const checking = new Map();
  const serial = work => {
    const task = tail.then(work);
    tail = task.catch(() => {});
    return task;
  };
  const read = async () => {
    const data = (await storage.get(FOLLOW_KEY))[FOLLOW_KEY];
    if (data === undefined) return [];
    if (data?.version !== 1 || !Array.isArray(data.items)) throw new Error('Following data is unreadable. Export a backup before making changes.');
    return data.items;
  };
  const write = items => {
    const value = {version:1,items};
    if (new TextEncoder().encode(JSON.stringify(value)).length > 5*1024*1024) {
      throw new Error('Following data exceeds 5 MB. Export a backup and remove some series.');
    }
    return storage.set({ [FOLLOW_KEY]: value });
  };
  const list = () => serial(read);
  return {
    list,
    add: data => serial(async () => {
      const id = followId(data.adapterId,data.ref);
      const items = await read();
      const existing = items.find(item => item.id === id);
      if (existing) return existing; // Re-following must not reset pending chapters.
      if (items.length >= MAX_FOLLOWED) throw new Error(`Following is limited to ${MAX_FOLLOWED} series.`);
      const entry = createFollowEntry(data,now(),token());
      await write([...items,entry]);
      return entry;
    }),
    remove: id => serial(async () => {
      const items = await read();
      await write(items.filter(item => item.id !== id));
      return {removed:items.some(item => item.id === id)};
    }),
    handled: (id,ids) => serial(async () => {
      const items = await read();
      const index = items.findIndex(item => item.id === id);
      if (index < 0) throw new Error('This series is no longer followed.');
      items[index] = markHandled(items[index],ids);
      await write(items);
      return items[index];
    }),
    check(id, loadSeries) {
      // Two app tabs checking the same series share a request, so an older
      // network response cannot overwrite a newer available-chapter snapshot.
      if (checking.has(id)) return checking.get(id);
      const task = (async () => {
      const before = (await list()).find(item => item.id === id);
      if (!before) throw new Error('This series is no longer followed.');
      let result;
      let failure;
      try { result = await loadSeries({adapterId:before.adapterId,ref:before.ref}); }
      catch (error) { failure = error; }
      // Network wait is outside the write queue. Removal/re-add cannot resurrect
      // an old entry, and acknowledging chapters during a check is preserved.
      return serial(async () => {
        const items = await read();
        const index = items.findIndex(item => item.id === id && item.token === before.token);
        if (index < 0) throw new Error('Following changed while checking. Please retry.');
        if (failure) {
          items[index] = {...items[index],lastAttemptAt:now(),lastError:String(failure.message ?? failure).slice(0,1000)};
          await write(items);
          throw failure;
        }
        try {
          if (followId(result.adapterId,result.ref) !== id) throw new Error('Series response does not match the followed series.');
          items[index] = updateFollowEntry(items[index],result.series,now());
        } catch (error) {
          items[index] = {...items[index],lastAttemptAt:now(),lastError:String(error.message).slice(0,1000)};
          await write(items);
          throw error;
        }
        await write(items);
        return {entry:items[index],result};
      });
      })();
      checking.set(id,task);
      task.finally(() => checking.delete(id)).catch(() => {});
      return task;
    },
    export: async () => ({version:1,items:(await list()).map(({token:_,...item}) => item)}),
    import: input => serial(async () => {
      const incoming = parseFollowBackup(input);
      const items = await read();
      const ids = new Set(items.map(item => item.id));
      const additions = incoming.filter(item => !ids.has(item.id)).map(item => ({...item,token:token()}));
      if (items.length + additions.length > MAX_FOLLOWED) throw new Error('Too many followed series after import.');
      await write([...items,...additions]);
      return {added:additions.length,skipped:incoming.length-additions.length};
    }),
  };
}
