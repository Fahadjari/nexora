import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  isSuperAdmin: boolean;
}

export interface AuthTenant {
  id: string;
  slug: string;
  name: string;
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: AuthUser | null;
  tenant: AuthTenant | null;
  permissions: string[];

  /**
   * False until the persisted state has been read back from localStorage.
   *
   * This flag exists because of a genuine Next.js trap. The server renders the
   * page with an empty store (there is no localStorage on a server), so the
   * first client render must match that — otherwise React throws a hydration
   * mismatch. If we redirect to /login based on "no token" before rehydration
   * finishes, we bounce every already-logged-in user straight back to the
   * login screen on every hard refresh. So: wait for this to turn true before
   * deciding anything about auth.
   */
  hasHydrated: boolean;

  setSession: (session: {
    accessToken: string;
    refreshToken: string;
    user?: AuthUser;
    tenant?: AuthTenant;
    permissions?: string[];
  }) => void;
  clear: () => void;
  can: (permission: string) => boolean;

  /** Called once by the persist middleware when rehydration completes. */
  setHasHydrated: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      tenant: null,
      permissions: [],
      hasHydrated: false,

      setSession: (session) =>
        set((state) => ({
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
          // A token refresh returns tokens only, not the user. Keep whatever we
          // already had rather than blanking the profile on every refresh.
          user: session.user ?? state.user,
          tenant: session.tenant ?? state.tenant,
          permissions: session.permissions ?? state.permissions,
        })),

      clear: () =>
        set({
          accessToken: null,
          refreshToken: null,
          user: null,
          tenant: null,
          permissions: [],
        }),

      /**
       * Whether the current user holds a permission.
       *
       * This is for *rendering* only — hiding a button the user cannot use. It
       * is not security. The real check runs in the API's PermissionsGuard,
       * because anything decided in the browser can be edited in the browser.
       * A hidden button is a courtesy; a rejected request is the control.
       */
      can: (permission) => {
        const { permissions } = get();
        return permissions.includes('*') || permissions.includes(permission);
      },

      setHasHydrated: () => set({ hasHydrated: true }),
    }),
    {
      name: 'nexora-auth',
      storage: createJSONStorage(() => localStorage),

      // Persist only what cannot be re-derived. `hasHydrated` in particular must
      // never be persisted — it would be restored as `true` before rehydration
      // had actually happened, which defeats the entire purpose of the flag.
      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        user: state.user,
        tenant: state.tenant,
        permissions: state.permissions,
      }),

      // Fires once localStorage has been read back. Everything that depends on
      // "am I logged in?" waits for this.
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated();
      },
    },
  ),
);
