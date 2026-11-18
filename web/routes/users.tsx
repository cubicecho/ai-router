import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteUserDocument, MeDocument, SetUserRoleDocument, UsersDocument } from '@/__generated__/graphql';
import { ConfirmButton } from '@/components/confirm-button';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { request } from '@/lib/gql';
import { Role } from '@/lib/roles';

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

  return (
    <PageLayout
      title="Users"
      description="Anyone your sign-in provider lets through can sign in. Admins may also set secrets, settings and roles."
      contentSlot={
        <>
          <LoadState query={users} what="the users" count={rows.length} />
          <List
            label="Users"
            contentSlot={rows.map((user) => {
              const isAdmin = user.role === Role.Admin;
              const isMe = user.id === me.data?.me.id;
              return (
                <ListItem
                  key={user.id}
                  title={user.name ?? user.email}
                  description={user.email}
                  meta={isAdmin ? <Badge>Admin</Badge> : undefined}
                  actionSlot={
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
