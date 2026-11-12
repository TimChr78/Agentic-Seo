// The workspace roles, named as a person sees them. The permission matrix itself lives on the
// server (packages/commands/src/principal.ts); the UI only labels the role it was given.
const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  editor: 'Editor',
  approver: 'Approver',
  viewer: 'Viewer',
};

export const roleName = (role: string) => ROLE_LABELS[role] ?? role;
