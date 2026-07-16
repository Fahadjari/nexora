'use client';

import { Check, Copy, Mail, Trash2, UserPlus, Users, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button, Card, EmptyState, Input, Skeleton, cn } from '@/components/ui';
import { useSubscription } from '@/features/billing/use-billing';
import {
  useChangeRole,
  useInvitations,
  useInvite,
  useMembers,
  useRemoveMember,
  useRevokeInvitation,
  useRoles,
  type Member,
} from '@/features/team/use-team';
import { useAuthStore } from '@/lib/auth-store';

/**
 * One row of the team table. The role is an inline <select> rather than a
 * separate edit screen — changing someone's role is a two-second decision and
 * deserves a two-second interaction.
 */
function MemberRow({
  member,
  isSelf,
  canUpdate,
  canRemove,
}: {
  member: Member;
  isSelf: boolean;
  canUpdate: boolean;
  canRemove: boolean;
}) {
  const { data: roles } = useRoles();
  const changeRole = useChangeRole();
  const removeMember = useRemoveMember();
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const initials = `${member.user.firstName[0] ?? ''}${member.user.lastName[0] ?? ''}`;

  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-[11px] font-semibold text-accent">
            {initials}
          </div>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium">
              {member.user.firstName} {member.user.lastName}
              {isSelf && <span className="ml-1.5 text-[11px] font-normal text-subtle">(you)</span>}
            </p>
            <p className="truncate text-[12px] text-subtle">{member.user.email}</p>
          </div>
        </div>
      </td>

      <td className="px-4 py-3">
        {canUpdate && !isSelf ? (
          <select
            value={member.role.id}
            onChange={(event) =>
              changeRole.mutate({ membershipId: member.id, roleId: event.target.value })
            }
            aria-label={`Role for ${member.user.firstName} ${member.user.lastName}`}
            className="rounded-md border border-border bg-surface px-2 py-1 text-[13px] transition-colors hover:border-subtle/40"
          >
            {roles?.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
        ) : (
          // Your own role is not self-service — the API's last-owner guard has
          // opinions — and without member:update it is read-only anyway.
          <span className="inline-flex rounded-md bg-muted px-2 py-0.5 text-[12px] font-medium">
            {member.role.name}
          </span>
        )}
      </td>

      <td className="px-4 py-3 text-right">
        {canRemove && !isSelf && (
          confirmingRemove ? (
            // Two-step confirm, inline. A modal for this is ceremony; a single
            // unconfirmed click that ends someone's access is a hazard. This is
            // the middle path.
            <span className="inline-flex items-center gap-1">
              <Button
                variant="danger"
                size="sm"
                loading={removeMember.isPending}
                onClick={() => removeMember.mutate(member.id)}
              >
                Confirm
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmingRemove(false)}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </span>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Remove ${member.user.firstName} ${member.user.lastName}`}
              onClick={() => setConfirmingRemove(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )
        )}
      </td>
    </tr>
  );
}

export default function TeamSettingsPage() {
  const can = useAuthStore((state) => state.can);
  const currentUser = useAuthStore((state) => state.user);

  const { data: members, isLoading } = useMembers();
  const { data: invitations } = useInvitations();
  const { data: roles } = useRoles();
  const { data: billing } = useSubscription();

  const invite = useInvite();
  const revoke = useRevokeInvitation();

  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  /** The last invite's URL, held for copying. See useInvite on why it matters. */
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const canInvite = can('member:invite');
  const canUpdate = can('member:update');
  const canRemove = can('member:remove');

  const seatsUsed = billing?.seatsUsed ?? 0;
  const seatLimit = billing?.entitlements.seats ?? 0;
  const seatsFull = seatLimit > 0 && seatsUsed >= seatLimit;

  async function handleInvite(event: FormEvent) {
    event.preventDefault();

    const defaultRole = roleId || roles?.find((role) => role.key === 'employee')?.id;
    if (!defaultRole) return;

    const result = await invite.mutateAsync({ email: email.trim(), roleId: defaultRole });

    setInviteUrl(result.inviteUrl);
    setEmail('');
    toast.success('Invitation created', {
      description: 'Copy the link below and send it — it works for 7 days.',
    });
  }

  async function copyInviteUrl() {
    if (!inviteUrl) return;

    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-6">
      {/* --- Invite --- */}
      {canInvite && (
        <Card className="p-5">
          <div className="mb-1 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Invite someone</h2>
            {/* The seat meter, always visible next to the action it governs. */}
            <span
              className={cn(
                'rounded-md px-1.5 py-0.5 text-[12px] font-medium tabular',
                seatsFull ? 'bg-danger/10 text-danger' : 'bg-muted text-subtle',
              )}
            >
              {seatsUsed}/{seatLimit} seats
            </span>
          </div>
          <p className="mb-4 text-[12px] text-subtle">
            Pending invitations hold a seat until they are accepted or revoked.
          </p>

          {seatsFull ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-3 text-[13px] text-subtle">
              Every seat is taken. <a href="/settings/billing" className="font-medium text-accent hover:underline">Add seats</a>{' '}
              or remove a member to invite someone new.
            </p>
          ) : (
            <form onSubmit={handleInvite} className="flex flex-wrap items-end gap-3" noValidate>
              <div className="min-w-56 flex-1">
                <Input
                  label="Email"
                  name="inviteEmail"
                  type="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="teammate@company.com"
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="inviteRole" className="block text-[13px] font-medium">
                  Role
                </label>
                <select
                  id="inviteRole"
                  value={roleId}
                  onChange={(event) => setRoleId(event.target.value)}
                  className="h-9 rounded-lg border border-border bg-surface px-3 text-sm transition-colors hover:border-subtle/40"
                >
                  {roles?.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
              </div>

              <Button
                type="submit"
                loading={invite.isPending}
                icon={<UserPlus className="h-4 w-4" />}
              >
                Invite
              </Button>
            </form>
          )}

          {inviteUrl && (
            <div className="mt-4 flex items-center gap-2 rounded-lg bg-muted px-3 py-2">
              <Mail className="h-4 w-4 shrink-0 text-subtle" />
              {/* The link IS the delivery mechanism until email sending is wired
                  up — hence it stays on screen until dismissed, not in a toast
                  that vanishes mid-copy. */}
              <code className="min-w-0 flex-1 truncate text-[12px]">{inviteUrl}</code>
              <Button variant="secondary" size="sm" onClick={() => void copyInviteUrl()}>
                {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
              <Button variant="ghost" size="sm" aria-label="Dismiss" onClick={() => setInviteUrl(null)}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </Card>
      )}

      {/* --- Pending invitations --- */}
      {invitations && invitations.length > 0 && (
        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">Pending invitations</h2>
          </div>
          <ul>
            {invitations.map((invitation) => (
              <li
                key={invitation.id}
                className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 last:border-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium">{invitation.email}</p>
                  <p className="text-[12px] text-subtle">
                    {invitation.role.name} · invited by {invitation.invitedBy.firstName}{' '}
                    {invitation.invitedBy.lastName}
                  </p>
                </div>
                {canInvite && (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={revoke.isPending}
                    onClick={() => revoke.mutate(invitation.id)}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* --- Members --- */}
      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Members</h2>
        </div>

        {isLoading ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : !members || members.length === 0 ? (
          <EmptyState
            icon={<Users className="h-5 w-5" />}
            title="Just you so far"
            description="Invite your team above — Nexora is built for more than one pair of hands."
          />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[12px] font-medium uppercase tracking-wide text-subtle">
                <th scope="col" className="px-4 py-2.5">Person</th>
                <th scope="col" className="px-4 py-2.5">Role</th>
                <th scope="col" className="px-4 py-2.5" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <MemberRow
                  key={member.id}
                  member={member}
                  isSelf={member.user.id === currentUser?.id}
                  canUpdate={canUpdate}
                  canRemove={canRemove}
                />
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
