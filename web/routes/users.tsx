import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteUserDocument, MeDocument, SetUserRoleDocument, UsersDocument } from '@/__generated__/graphql';
import { ConfirmButton } from '@/components/confirm-button';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { countOf, formatDate } from '@/lib/format';
import { request } from '@/lib/gql';
import { Role } from '@/lib/roles';

/**
 * Says how many people there are, and how many of them are admins.
 *
 * @param users - How many have signed in.
 * @param admins - How many of them are admins.
 * @returns Such as "4 users · 1 admin".
 */
function headcountOf(users: number, admins: number): string {
  return `${countOf(users, 'user', 'users')} · ${countOf(admins, 'admin', 'admins')}`;
}

/** Everyone who has signed in, and who of them is an admin. Admin only. */
export function UsersRoute() {
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => request(UsersDocument) });
  const me = useQuery({ queryKey: ['me'], queryFn: () => request(MeDocument) });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['users'] });
    void queryClient.invalidateQueries({ queryKey: ['me'] });
  };
  const setRole = useMutation({
    mutationFn: (change: { id: string; role: (typeof Role)[keyof typeof Role] }) =>
      request(SetUserRoleDocument, change),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: (id: string) => request(DeleteUserDocument, { id }), onSuccess: refresh });
  const rows = users.data?.users ?? [];
  const adminCount = rows.filter((user) => user.role === Role.Admin).length;

  return (
    <PageLayout
      width="full"
      title="Users"
      description="Anyone your sign-in provider lets through can sign in. Admins may also set secrets, settings and roles."
      actionSlot={
        rows.length > 0 ? <Badge variant="secondary">{headcountOf(rows.length, adminCount)}</Badge> : undefined
      }
      contentSlot={
        <>
          <LoadState query={users} what="the users" count={rows.length} />
          <List
            label="Users"
            contentSlot={rows.map((user) => {
              const isAdmin = user.role === Role.Admin;
              const isMe = user.id === me.data?.me.id;
              // The router refuses to demote or delete the last admin, so the page doesn't offer it.
              const isOnlyAdmin = isAdmin && adminCount === 1;
              return (
                <ListItem
                  key={user.id}
                  title={user.name ?? user.email}
                  description={
                    isOnlyAdmin
                      ? `${user.email} · The only admin: make someone else admin to change this one.`
                      : user.email
                  }
                  meta={
                    <span className="flex items-center gap-2 text-foreground/60 text-xs">
                      <span>Joined {formatDate(user.createdAt)}</span>
                      {isMe ? <Badge variant="info-soft">You</Badge> : null}
                      {isAdmin ? <Badge>Admin</Badge> : null}
                    </span>
                  }
                  actionSlot={
                    isOnlyAdmin ? undefined : (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          loading={setRole.isPending && setRole.variables?.id === user.id}
                          onClick={() => setRole.mutate({ id: user.id, role: isAdmin ? Role.User : Role.Admin })}
                          content={isAdmin ? 'Make user' : 'Make admin'}
                        />
                        <ConfirmButton
                          size="sm"
                          title={isMe ? 'Delete your own account?' : `Delete ${user.name ?? user.email}?`}
                          description="They are signed out everywhere. They can sign in again if your provider still lets them."
                          onConfirm={() => remove.mutate(user.id)}
                          content="Delete"
                        />
                      </>
                    )
                  }
                />
              );
            })}
          />
        </>
      }
    />
  );
}
