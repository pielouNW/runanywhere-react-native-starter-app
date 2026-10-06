import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import { RunAnywhere } from '@runanywhere/core';
import type { GenerationEvent } from '@runanywhere/core';
import { Chat as NWChat, SamplerPresets } from 'react-native-nobodywho';
import { AppColors } from '../theme';
import { useModelService, MODEL_CREDITS, MODEL_IDS } from '../services/ModelService';
import { ChatMessageBubble, ChatMessage, ModelLoaderWidget } from '../components';

const MODEL_ID = MODEL_IDS.llm;
const MAX_TOKENS = 256;
const SYSTEM_PROMPT = 'You are a helpful assistant.';

/** RunAnywhere's llama.cpp backend loads with n_ctx 2048 and JS cannot change it, so NobodyWho matches. */
const CONTEXT_SIZE = 2048;

/**
 * Greedy decoding, to match NobodyWho's `SamplerPresets.greedy()`. RunAnywhere
 * builds a bare greedy sampler whenever temperature is 0; the other knobs are
 * pinned anyway so none of its defaults (top-k 40, min-p 0.05, repeat penalty
 * 1.1) can reach the chain.
 */
const RA_GREEDY = {
  temperature: 0,
  topK: 1,
  topP: 1,
  minP: 0,
  repetitionPenalty: 1,
  frequencyPenalty: 0,
  presencePenalty: 0,
} as const;

type Backend = 'RunAnywhere' | 'NobodyWho';

export const ChatScreen: React.FC = () => {
  const modelService = useModelService();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [streamingBackend, setStreamingBackend] = useState<Backend>('RunAnywhere');
  const [currentResponse, setCurrentResponse] = useState('');
  const flatListRef = useRef<FlatList>(null);
  const responseRef = useRef(''); // Track response for closure
  const wasCancelledRef = useRef(false);
  // Closing the stream iterator is what cancels the native generation now.
  const streamRef = useRef<AsyncIterator<GenerationEvent> | null>(null);
  const nwChatRef = useRef<NWChat | null>(null);

  const nwModel = modelService.nwModelId === MODEL_ID ? modelService.nwModel : null;

  // One NobodyWho chat per loaded model, with the same settings as RunAnywhere.
  useEffect(() => {
    if (!nwModel) return;
    const chat = new NWChat({
      model: nwModel,
      systemPrompt: SYSTEM_PROMPT,
      contextSize: CONTEXT_SIZE,
      sampler: SamplerPresets.greedy(),
      templateVariables: { enable_thinking: false },
    });
    nwChatRef.current = chat;
    return () => {
      nwChatRef.current = null;
      chat.stopGeneration();
      chat.destroy();
    };
  }, [nwModel]);

  useEffect(() => {
    // Scroll to bottom when messages change
    if (messages.length > 0) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [messages, currentResponse]);

  /** Stream one RunAnywhere reply into the live bubble; TTFT is measured here, tok/s comes from the SDK. */
  const runRA = async (text: string): Promise<ChatMessage> => {
    const startedAt = performance.now();
    let firstTokenAt: number | null = null;
    let tokensPerSecond: number | undefined;

    // Canonical cross-SDK streaming path: RunAnywhere.llm.generateStream()
    // returns an AsyncIterable<GenerationEvent>. Manual iterator.next()
    // loop — Hermes does not support `for await...of` over NitroModules
    // async iterables.
    const iterator = RunAnywhere.llm
      .generateStream(text, {
        systemPrompt: SYSTEM_PROMPT,
        maxOutputTokens: MAX_TOKENS,
        ...RA_GREEDY,
        reasoning: { mode: 'off' },
      })
      [Symbol.asyncIterator]();
    streamRef.current = iterator;

    try {
      for (;;) {
        const step = await iterator.next();
        if (step.done) break;
        const event = step.value;
        if (event.type === 'token') {
          if (firstTokenAt === null) firstTokenAt = performance.now();
          if (event.kind === 'text') {
            responseRef.current += event.text;
            setCurrentResponse(responseRef.current);
          }
        } else if (event.type === 'completed') {
          tokensPerSecond = event.result.tokensPerSecond;
          if (event.result.text) responseRef.current = event.result.text;
        } else if (event.type === 'cancelled') {
          // Terminal, like completed/failed. Native can cancel on its own
          // (not only via handleStop), so mark it here or the bubble renders
          // a truncated reply as if it finished normally.
          wasCancelledRef.current = true;
          if (!responseRef.current && typeof event.partial === 'string') {
            responseRef.current = event.partial;
          }
          break;
        } else if (event.type === 'failed') {
          throw event.error;
        }
      }
    } finally {
      streamRef.current = null;
    }

    return {
      text: responseRef.current,
      isUser: false,
      timestamp: new Date(),
      backend: 'RunAnywhere',
      tokensPerSecond,
      ttftMs: (firstTokenAt ?? performance.now()) - startedAt,
      wasCancelled: wasCancelledRef.current,
    };
  };

  /**
   * Stream one NobodyWho reply. History is reset first so it answers the same
   * single prompt RunAnywhere did. tok/s is decode-only, from first token on.
   */
  const runNW = async (chat: NWChat, text: string): Promise<ChatMessage> => {
    await chat.resetHistory();
    const startedAt = performance.now();
    let firstTokenAt: number | null = null;
    let generated = 0;

    // Manual iteration, like above: `nextToken` resolves undefined when done.
    const stream = chat.ask(text);
    for (;;) {
      const token = await stream.nextToken();
      if (token === undefined) break;
      if (firstTokenAt === null) firstTokenAt = performance.now();
      generated++;
      responseRef.current += token;
      setCurrentResponse(responseRef.current);
      // NobodyWho has no per-ask token cap; stop at the same budget.
      if (generated === MAX_TOKENS) chat.stopGeneration();
    }
    const finishedAt = performance.now();
    const decodeSeconds = firstTokenAt === null ? 0 : (finishedAt - firstTokenAt) / 1000;

    return {
      text: responseRef.current,
      isUser: false,
      timestamp: new Date(),
      backend: 'NobodyWho',
      tokensPerSecond: decodeSeconds > 0 ? (generated - 1) / decodeSeconds : 0,
      ttftMs: (firstTokenAt ?? finishedAt) - startedAt,
      wasCancelled: wasCancelledRef.current,
    };
  };

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || isGenerating) return;

    // Add user message
    const userMessage: ChatMessage = {
      text,
      isUser: true,
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, userMessage]);
    setInputText('');
    setIsGenerating(true);
    wasCancelledRef.current = false;

    // RunAnywhere first, then NobodyWho, each in its own bubble.
    const steps: [Backend, () => Promise<ChatMessage>][] = [
      ['RunAnywhere', () => runRA(text)],
      ['NobodyWho', () => runNW(nwChatRef.current!, text)],
    ];
    for (const [backend, run] of steps) {
      // Stop skips the engine that has not started yet.
      if (wasCancelledRef.current) break;
      setStreamingBackend(backend);
      setCurrentResponse('');
      responseRef.current = '';
      try {
        const reply = await run();
        setMessages(prev => [...prev, reply]);
      } catch (error) {
        const errorMessage: ChatMessage = {
          text: `${backend} error: ${error}`,
          isUser: false,
          timestamp: new Date(),
          isError: true,
        };
        setMessages(prev => [...prev, errorMessage]);
      }
    }

    setCurrentResponse('');
    responseRef.current = '';
    wasCancelledRef.current = false;
    setIsGenerating(false);
  };

  const handleStop = () => {
    wasCancelledRef.current = true;
    // The stream's own cancel hook calls into native cancellation. Swallow a
    // rejection from that teardown: it is fire-and-forget, and an unhandled
    // rejection here surfaces as a red-box warning in React Native.
    streamRef.current?.return?.(undefined)?.catch(() => {});
    nwChatRef.current?.stopGeneration();
  };

  const renderSuggestionChip = (text: string) => (
    <TouchableOpacity
      key={text}
      style={styles.suggestionChip}
      onPress={() => {
        setInputText(text);
        handleSend();
      }}
    >
      <Text style={styles.suggestionText}>{text}</Text>
    </TouchableOpacity>
  );

  if (modelService.loadedLLMId !== MODEL_ID || !nwModel) {
    const raBusy = modelService.isLLMDownloading || modelService.isLLMLoading;

    return (
      <ModelLoaderWidget
        modelCredit={MODEL_CREDITS.llm}
        title="LLM Model Required"
        subtitle="Load the same model in RunAnywhere and NobodyWho to compare their answers"
        icon="chat"
        accentColor={AppColors.accentCyan}
        isDownloading={raBusy ? modelService.isLLMDownloading : modelService.isNWDownloading}
        isLoading={raBusy ? modelService.isLLMLoading : modelService.isNWLoading}
        progress={raBusy ? modelService.llmDownloadProgress : modelService.nwDownloadProgress}
        progressLabel={raBusy ? 'RunAnywhere' : 'NobodyWho'}
        onLoad={async () => {
          if (modelService.loadedLLMId !== MODEL_ID) {
            await modelService.downloadAndLoadLanguageModel(MODEL_ID);
          }
          await modelService.downloadAndLoadNW(MODEL_ID);
        }}
      />
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      {messages.length === 0 ? (
        <View style={styles.emptyState}>
          <View style={styles.emptyIconContainer}>
            <Text style={styles.emptyIcon}>💬</Text>
          </View>
          <Text style={styles.emptyTitle}>Start a Conversation</Text>
          <Text style={styles.emptySubtitle}>
            Ask anything! RunAnywhere answers first, then NobodyWho, both on your device.
          </Text>
          <View style={styles.suggestionsContainer}>
            {renderSuggestionChip('Tell me a joke')}
            {renderSuggestionChip('What is AI?')}
            {renderSuggestionChip('Write a haiku')}
          </View>
        </View>
      ) : (
        <FlatList
          ref={flatListRef}
          data={[
            ...messages,
            ...(isGenerating
              ? [{ text: currentResponse || `${streamingBackend}…`, isUser: false, timestamp: new Date() }]
              : []),
          ]}
          renderItem={({ item, index }) => (
            <ChatMessageBubble
              message={item as ChatMessage}
              isStreaming={isGenerating && index === messages.length}
            />
          )}
          keyExtractor={(_, index) => index.toString()}
          contentContainerStyle={styles.messageList}
          showsVerticalScrollIndicator={false}
        />
      )}

      {/* Input Area */}
      <View style={styles.inputContainer}>
        <View style={styles.inputWrapper}>
          <TextInput
            style={styles.input}
            placeholder="Type a message..."
            placeholderTextColor={AppColors.textMuted}
            value={inputText}
            onChangeText={setInputText}
            onSubmitEditing={handleSend}
            editable={!isGenerating}
            multiline
          />
          {isGenerating ? (
            <TouchableOpacity onPress={handleStop} style={styles.stopButton}>
              <View style={styles.stopIcon}>
                <Text style={styles.stopIconText}>⏹</Text>
              </View>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity onPress={handleSend} disabled={!inputText.trim()}>
              <LinearGradient
                colors={[AppColors.accentCyan, AppColors.accentViolet]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.sendButton}
              >
                <Text style={styles.sendIcon}>📤</Text>
              </LinearGradient>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: AppColors.primaryDark,
  },
  messageList: {
    padding: 16,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  emptyIconContainer: {
    width: 100,
    height: 100,
    backgroundColor: AppColors.accentCyan + '20',
    borderRadius: 50,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  emptyIcon: {
    fontSize: 48,
  },
  emptyTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: AppColors.textPrimary,
    marginBottom: 12,
  },
  emptySubtitle: {
    fontSize: 14,
    color: AppColors.textSecondary,
    textAlign: 'center',
    marginBottom: 32,
  },
  suggestionsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
  },
  suggestionChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: AppColors.surfaceCard,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: AppColors.accentCyan + '40',
  },
  suggestionText: {
    fontSize: 12,
    color: AppColors.textPrimary,
  },
  inputContainer: {
    padding: 16,
    backgroundColor: AppColors.surfaceCard + 'CC',
    borderTopWidth: 1,
    borderTopColor: AppColors.textMuted + '1A',
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  input: {
    flex: 1,
    backgroundColor: AppColors.primaryMid,
    borderRadius: 24,
    paddingHorizontal: 20,
    paddingVertical: 12,
    fontSize: 15,
    color: AppColors.textPrimary,
    maxHeight: 100,
  },
  sendButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
    shadowColor: AppColors.accentCyan,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  sendIcon: {
    fontSize: 20,
  },
  stopButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: AppColors.error + '33',
    justifyContent: 'center',
    alignItems: 'center',
  },
  stopIcon: {
    width: 48,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
  },
  stopIconText: {
    fontSize: 20,
    color: AppColors.error,
  },
});
