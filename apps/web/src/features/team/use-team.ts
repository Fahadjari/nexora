'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiFetch, ApiRequestError } from '@/lib/api-client';
import { billingKeys } from '@/features/billing/use-billing';

export interface Member {
  id: string;
  status: 'INVITED' | 'ACTIVE' | 'SUSPENDED';
  jobTitle: string | null;
  createdAt: string;
  user: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    avatarUrl: string | null;
  };
  role: { id: string; key: string; name: string };
}

export interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
}

export interface PendingInvitation {
  id: string;
  email: string;
  status: string;
  expiresAt: string;
  createdAt: string;
  role: { id: string; name: string };
  invitedBy: { firstName: string; lastName: string };
}

export const teamKeys = {
  all: ['team'] as const,
  members: () => ['team', 'members'] as const,
  roles: () => ['team', 'roles'] as const,
  invitations: () => ['team', 'invitations'] as const,
};

export function useMembers() {
  return useQuery({
    queryKey: teamKeys.members(),
    queryFn: () => apiFetch<Member[]>('/members'),
  });
}

export function useRoles() {
  return useQuery({
    queryKey: teamKeys.roles(),
    queryFn: () => apiFetch<Role[]>('/members/roles'),
    // The role catalogue is near-static; don't refetch it per dialog open.
    staleTime: 5 * 60_000,
  });
}

export function useInvitations() {
  return useQuery({
    queryKey: teamKeys.invitations(),
    queryFn: () => apiFetch<PendingInvitation[]>('/members/invitations'),
  });
}

/**
 * Sends an invitation.
 *
 * The success handler does NOT toast — it hands the invite URL back to the
 * caller, because the URL is the payload the inviter needs (no mailer is wired
 * yet, so *they* deliver the link). A toast saying "invited!" while quietly
 * discarding the one thing that makes the invite usable would be worse than
 * failing.
 */
export function useInvite() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { email: string; roleId: string }) =>
      apiFetch<{ inviteUrl: string }>('/members/invitations', { method: 'POST', body: input }),

    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: teamKeys.invitations() });
      // An invite consumes a seat, and the billing card shows seat usage.
      void queryClient.invalidateQueries({ queryKey: billingKeys.all });
    },

    onError: (error) => {
      toast.error(
        error instanceof ApiRequestError ? error.message : 'Could not send the invitation.',
      );
    },
  });
}

export function useRevokeInvitation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => apiFetch(`/members/invitations/${id}`, { method: 'DELETE' }),

    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: teamKeys.invitations() });
      void queryClient.invalidateQueries({ queryKey: billingKeys.all });
      toast.success('Invitation revoked', { description: 'The link stops working immediately.' });
    },

    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : 'Could not revoke it.');
    },
  });
}

export function useChangeRole() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { membershipId: string; roleId: string }) =>
      apiFetch(`/members/${input.membershipId}/role`, {
        method: 'PATCH',
        body: { roleId: input.roleId },
      }),

    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: teamKeys.members() });
      toast.success('Role updated', {
        description: 'Takes effect on their very next request.',
      });
    },

    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : 'Could not change the role.');
    },
  });
}

export function useRemoveMember() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (membershipId: string) => apiFetch(`/members/${membershipId}`, { method: 'DELETE' }),

    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: teamKeys.members() });
      void queryClient.invalidateQueries({ queryKey: billingKeys.all });
      toast.success('Member removed', {
        description: 'Their access ended immediately. Their history stays.',
      });
    },

    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : 'Could not remove them.');
    },
  });
}

// --- Invite acceptance (public pages) ---------------------------------------

export interface InvitePreview {
  email: string;
  companyName: string;
  roleName: string;
  invitedBy: string;
  /** Decides which accept path the page shows: set a password, or sign in. */
  hasAccount: boolean;
}

export function useInvitePreview(token: string | null) {
  return useQuery({
    queryKey: ['invite-preview', token],
    queryFn: () => apiFetch<InvitePreview>(`/members/invitations/token/${token}`),
    enabled: Boolean(token),
    // One shot. Retrying a 404 three times just delays telling the person their
    // link is dead.
    retry: false,
  });
}
