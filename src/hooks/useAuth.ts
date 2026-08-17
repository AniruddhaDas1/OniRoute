import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { User } from '@supabase/supabase-js';

const DEMO_KEY = 'oniroute-demo';

function getDemoUser(): User | null {
  if (typeof localStorage === 'undefined') return null;
  if (localStorage.getItem(DEMO_KEY) !== 'true') return null;
  return {
    id: 'demo-user',
    email: 'leadspree24x7@gmail.com',
    user_metadata: {},
    app_metadata: {},
    aud: 'authenticated',
    role: 'authenticated',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    email_confirmed_at: new Date().toISOString(),
    last_sign_in_at: new Date().toISOString(),
    phone: '',
    phone_confirmed_at: null,
    is_sso_user: false,
    is_super_admin: true,
    is_anonymous: false,
    deleted_at: null,
  } as unknown as User;
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const isStandalone = Boolean(
    import.meta.env.VITE_API_URL ||
    import.meta.env.VITE_SUPABASE_URL?.includes(':1001')
  );

  useEffect(() => {
    if (isStandalone) {
      setUser({
        id: '00000000-0000-0000-0000-000000000000',
        email: 'leadspree24x7@gmail.com',
        aud: 'authenticated',
        role: 'authenticated',
      } as unknown as User);
      setLoading(false);
      return;
    }

    const demoUser = getDemoUser();
    if (demoUser) {
      setUser(demoUser);
      setLoading(false);
      return;
    }

    const getSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      setUser(session?.user ?? null);
      setLoading(false);
    };

    getSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (localStorage.getItem(DEMO_KEY) === 'true') {
        setUser(getDemoUser());
      } else {
        setUser(session?.user ?? null);
      }
      setLoading(false);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [isStandalone]);

  const isSuperAdmin = Boolean(
    user?.email &&
      (user.email.toLowerCase() === 'leadspree24x7@gmail.com' ||
        user.email === 'admin@oniroute.local')
  );

  const signUp = async (email: string, password: string) => {
    const { error } = await supabase.auth.signUp({ email, password });
    return { error };
  };

  const signIn = async (email: string, password: string) => {
    localStorage.removeItem(DEMO_KEY);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (!error && data?.user) {
      setUser(data.user);
    }
    return { error };
  };

  const signOut = useCallback(async () => {
    localStorage.removeItem(DEMO_KEY);
    setUser(null);
    try {
      await supabase.auth.signOut();
    } catch {
      // ignore
    }
    window.location.href = '/login';
  }, []);

  const enableDemo = () => {
    localStorage.setItem(DEMO_KEY, 'true');
    setUser(getDemoUser());
  };

  return { user, loading, signUp, signIn, signOut, enableDemo, isSuperAdmin };
}
