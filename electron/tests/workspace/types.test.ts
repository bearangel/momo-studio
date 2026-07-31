// electron/tests/workspace/types.test.ts
import { describe, it, expect } from 'vitest';
import type { Workspace, CreateWorkspaceInput } from '../../src/main/workspace/types';

describe('workspace/types', () => {
  it('Workspace 接口包含所有必需字段', () => {
    const ws: Workspace = {
      id: 'test-id',
      name: '测试工作空间',
      description: '',
      directoryPath: '/tmp/test',
      matrixSpaceId: '!space:localhost',
      teamRoomId: '!team:localhost',
      gitInitialized: false,
      createdAt: '2026-01-01T00:00:00Z',
      ownerId: '@alice:localhost',
      iconEmoji: '📁',
      coordinatorInstanceId: null,
    };
    expect(ws.id).toBe('test-id');
    expect(ws.name).toBe('测试工作空间');
    expect(ws.teamRoomId).toBe('!team:localhost');
  });

  it('CreateWorkspaceInput 只需 name + directoryPath', () => {
    const input: CreateWorkspaceInput = {
      name: '新项目',
      directoryPath: '/tmp/new-project',
    };
    expect(input.name).toBe('新项目');
    expect(input.description).toBeUndefined();
  });
});
