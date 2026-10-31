import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { fetchHouseholds, fetchMembers } from './data.js';
import { get, set } from './lib/idb.js';

const Ctx = createContext({ members: [], households: [], byId: new Map(), reload: () => {} });
export const useMembers = () => useContext(Ctx);

export function MembersProvider({ children }) {
  const [members, setMembers] = useState([]);
  const [households, setHouseholds] = useState([]);

  const reload = useCallback(async () => {
    const [m, h] = await Promise.all([fetchMembers(), fetchHouseholds()]);
    if (!m.error) { setMembers(m.data); set('members', m.data); }
    if (!h.error) { setHouseholds(h.data); set('households', h.data); }
  }, []);

  useEffect(() => {
    get('members').then((c) => c && setMembers((cur) => (cur.length ? cur : c)));
    get('households').then((c) => c && setHouseholds((cur) => (cur.length ? cur : c)));
    reload();
  }, [reload]);

  const value = useMemo(() => ({ members, households, byId: new Map(members.map((m) => [m.id, m])), reload }), [members, households, reload]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
