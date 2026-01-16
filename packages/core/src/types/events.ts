export type CoreEvents = {
  'task:start': [ { taskName: string } ];
  'task:progress': [ { message: string; current: number; total: number } ];
  'task:error': [ { error: Error } ];
  'task:complete': [ { success: boolean } ];
};