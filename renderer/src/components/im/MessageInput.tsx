// renderer/src/components/im/MessageInput.tsx
//
// 消息输入框：Enter 发送，Shift+Enter 换行。
// 发送失败时恢复文本，让用户可重试。未选 room 时禁用。
import { useState, useCallback, type KeyboardEvent } from 'react';
import { useImStore } from '../../stores/im.store';

export function MessageInput() {
  const [text, setText] = useState('');
  const activeRoomId = useImStore((s) => s.activeRoomId);
  const sendMessage = useImStore((s) => s.sendMessage);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || !activeRoomId) return;
    setText('');
    try {
      await sendMessage(trimmed);
    } catch {
      // 发送失败时恢复文本，让用户可重试
      setText(trimmed);
    }
  }, [text, activeRoomId, sendMessage]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="border-t border-border-subtle bg-bg-secondary p-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={!activeRoomId}
        placeholder={activeRoomId ? '输入消息，Enter 发送，Shift+Enter 换行' : '请先选择房间'}
        rows={2}
        className="w-full resize-none rounded-md bg-bg-tertiary border border-border-subtle px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 focus:border-accent-blue focus:outline-none disabled:opacity-50"
      />
    </div>
  );
}
