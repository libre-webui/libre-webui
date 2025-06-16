import React from 'react';
import { ChatLayout } from '@/layouts/ChatLayout';
import { ChatMessages } from '@/components/ChatMessages';
import { ChatInput } from '@/components/ChatInput';
import { useChatStore } from '@/store/chatStore';
import { useChat } from '@/hooks/useChat';

export const Chat: React.FC = () => {
  const { currentSession } = useChatStore();
  const { sendMessage, stopGeneration } = useChat(currentSession?.id || '');

  const handleSendMessage = (message: string) => {
    if (!currentSession) return;
    sendMessage(message);
  };

  return (
    <ChatLayout>
      <div className='flex-1 flex flex-col h-full'>
        <ChatMessages messages={currentSession?.messages || []} />
        <ChatInput
          onSendMessage={handleSendMessage}
          onStopGeneration={stopGeneration}
        />
      </div>
    </ChatLayout>
  );
};
