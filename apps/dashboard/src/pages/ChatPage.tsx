import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { dashboardApiClient } from '../api/client';
import type { Conversation, ConversationMessage, ChatComposerMode } from '../types/dashboard';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { appIcons } from '../lib/icons';

const formatTime = (iso?: string): string => {
  if (!iso) return 'never';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString();
};

const relativeTime = (iso?: string): string => {
  if (!iso) return '';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '';
  const deltaMs = Date.now() - parsed.getTime();
  const deltaMin = Math.round(deltaMs / 60000);
  if (deltaMin < 1) return 'now';
  if (deltaMin < 60) return `${deltaMin}m`;
  const deltaHr = Math.round(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h`;
  const deltaDay = Math.round(deltaHr / 24);
  return `${deltaDay}d`;
};

const titleFromMessage = (text: string): string => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'New conversation';
  return normalized.slice(0, 64);
};

export function ChatPage() {
  const ChatIcon = appIcons.chat;
  const MissionIcon = appIcons.focus;
  const AutoIcon = appIcons.next;
  const CompactIcon = appIcons.compact;
  const SendIcon = appIcons.send;

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [composer, setComposer] = useState('');
  const [mode, setMode] = useState<ChatComposerMode>('auto');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [search, setSearch] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const selectedConversationRef = useRef<string | null>(null);
  const messageRequestSeqRef = useRef(0);

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === conversationId) ?? null,
    [conversations, conversationId],
  );

  const filteredConversations = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return conversations;
    return conversations.filter((conversation) =>
      `${conversation.title} ${conversation.id}`.toLowerCase().includes(term),
    );
  }, [conversations, search]);

  useEffect(() => {
    selectedConversationRef.current = conversationId;
  }, [conversationId]);

  const loadConversations = useCallback(async (preferredConversationId?: string) => {
    const list = await dashboardApiClient.getConversations();
    setConversations(list.items);

    const selectedId = preferredConversationId ?? selectedConversationRef.current;
    if (selectedId && list.items.some((item) => item.id === selectedId)) {
      if (conversationId !== selectedId) {
        setConversationId(selectedId);
      }
      return;
    }
    if (!selectedId && list.items.length > 0) {
      setConversationId(list.items[0].id);
    }
  }, [conversationId]);

  const loadMessages = useCallback(async (targetConversationId: string) => {
    const seq = messageRequestSeqRef.current + 1;
    messageRequestSeqRef.current = seq;
    const detail = await dashboardApiClient.getConversation(targetConversationId);
    if (messageRequestSeqRef.current !== seq) return;
    if (selectedConversationRef.current !== targetConversationId) return;
    setMessages(detail.messages);
  }, []);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const list = await dashboardApiClient.getConversations();
        if (!mounted) return;
        if (list.items.length === 0) {
          const created = await dashboardApiClient.createConversation('General');
          if (!mounted) return;
          setConversations([created]);
          setConversationId(created.id);
          const detail = await dashboardApiClient.getConversation(created.id);
          if (!mounted) return;
          setMessages(detail.messages);
        } else {
          setConversations(list.items);
          const initialId = list.items[0].id;
          setConversationId(initialId);
          selectedConversationRef.current = initialId;
          const detail = await dashboardApiClient.getConversation(initialId);
          if (!mounted) return;
          setMessages(detail.messages);
        }
      } catch (loadError) {
        if (!mounted) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [loadMessages]);

  useEffect(() => {
    if (!conversationId) return;
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    pollRef.current = setInterval(() => {
      void loadMessages(conversationId);
      void loadConversations(conversationId);
    }, 1500);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [conversationId, loadConversations, loadMessages]);

  useEffect(() => {
    const el = messageListRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onCreateConversation = async () => {
    try {
      const title = titleFromMessage(composer);
      const created = await dashboardApiClient.createConversation(title || 'New conversation');
      await loadConversations(created.id);
      setConversationId(created.id);
      selectedConversationRef.current = created.id;
      const detail = await dashboardApiClient.getConversation(created.id);
      setMessages(detail.messages);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    }
  };

  const onSelectConversation = async (id: string) => {
    selectedConversationRef.current = id;
    setConversationId(id);
    setError(null);
    try {
      await loadMessages(id);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  };

  const dispatchMessage = async () => {
    if (!conversationId || !composer.trim() || busy) return;
    const content = composer.trim();
    const autoMission = /\b(run|execute|fix|implement|refactor|open pr|benchmark|investigate|ship|patch)\b/i.test(content);
    const resolvedMode = mode === 'auto' ? (autoMission ? 'mission' : 'chat') : mode;
    setComposer('');
    setBusy(true);
    setError(null);
    const nowIso = new Date().toISOString();
    const optimisticRunId = `optimistic_${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: `user_${Date.now()}`,
        conversationId,
        role: 'user',
        mode: resolvedMode,
        status: 'done',
        content,
        runId: optimisticRunId,
        evidenceRefs: [],
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        id: `assistant_${Date.now()}`,
        conversationId,
        role: 'assistant',
        mode: resolvedMode,
        status: 'running',
        content: '',
        runId: optimisticRunId,
        evidenceRefs: [],
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    ]);
    try {
      await dashboardApiClient.sendConversationMessage({
        conversationId,
        content,
        mode: resolvedMode,
      });
      await loadMessages(conversationId);
      await loadConversations(conversationId);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError));
    } finally {
      setBusy(false);
    }
  };

  const onSend = (event: FormEvent) => {
    event.preventDefault();
    void dispatchMessage();
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void dispatchMessage();
    }
  };

  const onCompact = async () => {
    if (!conversationId) return;
    setCompacting(true);
    setError(null);
    try {
      await dashboardApiClient.compactConversation(conversationId);
    } catch (compactError) {
      setError(compactError instanceof Error ? compactError.message : String(compactError));
    } finally {
      setCompacting(false);
    }
  };

  if (loading) {
    return (
      <section>
        <Card>
          <CardHeader>
            <CardTitle>Chat</CardTitle>
          </CardHeader>
          <CardContent>Loading conversations...</CardContent>
        </Card>
      </section>
    );
  }

  return (
    <section className="chat-page">
      <Card className="chat-sidebar-card">
        <CardHeader className="chat-sidebar-head">
          <CardTitle>Conversations</CardTitle>
          <Button onClick={onCreateConversation} size="sm" variant="outline" type="button">
            New
          </Button>
        </CardHeader>
        <CardContent className="chat-conversation-list">
          <input
            className="chat-conversation-search"
            placeholder="Search conversations"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            aria-label="Search conversations"
          />
          {filteredConversations.map((conversation) => (
            <button
              key={conversation.id}
              className={`chat-conversation-item${conversation.id === conversationId ? ' active' : ''}`}
              onClick={() => onSelectConversation(conversation.id)}
              type="button"
            >
              <span className="chat-conversation-title">{conversation.title}</span>
              <span className="chat-conversation-time">
                {relativeTime(conversation.lastMessageAt ?? conversation.updatedAt)} · {formatTime(conversation.lastMessageAt ?? conversation.updatedAt)}
              </span>
            </button>
          ))}
          {filteredConversations.length === 0 ? <p className="muted">No conversations match.</p> : null}
        </CardContent>
      </Card>

      <Card className="chat-main-card">
        <CardHeader className="chat-main-head">
          <div>
            <CardTitle>{selectedConversation?.title ?? 'Conversation'}</CardTitle>
            <p className="muted">Auto route on. Switch to Mission for heavier work.</p>
          </div>
          <div className="chat-main-controls">
            <div className="chat-mode-group" role="group" aria-label="Chat mode">
              <Button
                type="button"
                size="sm"
                variant={mode === 'auto' ? 'default' : 'outline'}
                onClick={() => setMode('auto')}
              >
                <AutoIcon className="icon icon-16" aria-hidden="true" />
                Auto
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mode === 'chat' ? 'default' : 'outline'}
                onClick={() => setMode('chat')}
              >
                <ChatIcon className="icon icon-16" aria-hidden="true" />
                Chat
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mode === 'mission' ? 'default' : 'outline'}
                onClick={() => setMode('mission')}
              >
                <MissionIcon className="icon icon-16" aria-hidden="true" />
                Mission
              </Button>
            </div>
            <Button type="button" size="sm" variant="ghost" onClick={onCompact} disabled={compacting}>
              <CompactIcon className="icon icon-16" aria-hidden="true" />
              {compacting ? 'Compacting...' : 'Compact'}
            </Button>
          </div>
        </CardHeader>

        <CardContent className="chat-main-body">
          <div ref={messageListRef} className="chat-message-list">
            {messages.length === 0 ? <p className="muted">No messages yet. Start the conversation.</p> : null}
            {messages.map((message) => (
              <article key={message.id} className={`chat-message chat-message--${message.role}`}>
                <header className="chat-message-meta">
                  <span>{message.role === 'assistant' ? 'Sq' : 'You'}</span>
                  {message.status !== 'done' ? <span>{message.status}</span> : null}
                  {message.evidenceRefs.length > 0 ? <span>{message.evidenceRefs.length} refs</span> : null}
                </header>
                <p>{message.content || (message.role === 'assistant' ? 'Thinking...' : '')}</p>
              </article>
            ))}
          </div>

          <form className="chat-composer" onSubmit={onSend}>
            <textarea
              aria-label="Message"
              className="chat-composer-input"
              onChange={(event) => setComposer(event.currentTarget.value)}
              onKeyDown={onComposerKeyDown}
              placeholder="Ask Squidward anything..."
              value={composer}
            />
            <div className="chat-composer-actions">
              {error ? <span className="chat-error">{error}</span> : <span className="muted">Enter to send · Shift+Enter for newline · Mode: {mode}</span>}
              <Button type="submit" disabled={busy || !composer.trim()}>
                <SendIcon className="icon icon-16" aria-hidden="true" />
                {busy ? 'Sending...' : 'Send'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </section>
  );
}
