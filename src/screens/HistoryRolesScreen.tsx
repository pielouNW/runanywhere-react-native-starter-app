/**
 * HistoryRolesScreen
 *
 * RunAnywhere's C ABI carries history as a role-less array of alternating
 * strings. llm_module.cpp:1701-1728 skips every message that is not user or
 * assistant, so `tool` messages and mid-conversation `system` messages are
 * dropped without a warning, even though the RN `ChatMessage` type accepts
 * them.
 *
 * The conversation hides a tracking number only in a `tool` message and asks
 * for it. A control run moves the same tool result into the last user message,
 * which RunAnywhere keeps, and shows the model can answer when the fact
 * actually reaches it.
 *
 * NobodyWho answers the same two conversations with `Chat.complete`, which
 * keeps every role and renders the tool message through the model's chat
 * template.
 */

import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { RunAnywhere } from '@runanywhere/core';
import type { ChatMessage } from '@runanywhere/core';
import { Chat as NWChat, SamplerPresets } from 'react-native-nobodywho';
import type { Message as NWMessage } from 'react-native-nobodywho';
import { AppColors } from '../theme';
import { useModelService, MODEL_CREDITS, MODEL_IDS } from '../services/ModelService';
import { ModelLoaderWidget, ActionButton, FindingHeader, MONO } from '../components';

const ACCENT = AppColors.accentOrange;

const EXPECT = '88213';
const TOOL_RESULT =
  '{"order":"44179","status":"shipped","carrier":"DHL","tracking":"DHL-88213"}';
const QUESTION = 'What is the tracking number? Reply with numbers only.';

/** The tracking number lives only in the `tool` message. */
const CHAT_HISTORY: ChatMessage[] = [
  { role: 'user', content: 'Where is my latest order?' },
  { role: 'assistant', content: 'Let me look that up for you.' },
  { role: 'tool', toolCallId: 'call_1', content: TOOL_RESULT },
  { role: 'user', content: QUESTION },
];

/** The same conversation with the tool result pasted into the last user message. */
const CONTROL_HISTORY: ChatMessage[] = [
  ...CHAT_HISTORY.slice(0, 2),
  { role: 'user', content: `Order lookup result: ${TOOL_RESULT}\n\n${QUESTION}` },
];

interface Replies {
  chatHistoryReply: string;
  controlReply: string;
}

interface EngineReplies {
  runAnywhere: Replies;
  nobodyWho: Replies;
}

const askRA = async (messages: ChatMessage[]): Promise<string> => {
  const result = await RunAnywhere.llm.generate(messages, {
    maxOutputTokens: 64,
    temperature: 0,
    reasoning: { mode: 'off' },
    toolChoice: 'none',
  });
  return result.text.trim();
};

/** NobodyWho names a tool message after its tool rather than a call id. */
const toNWMessage = (msg: ChatMessage): NWMessage =>
  msg.role === 'tool'
    ? { role: 'tool', name: 'lookup_order', content: msg.content }
    : msg.role === 'assistant'
      ? { role: 'assistant', content: msg.content }
      : { role: msg.role, content: msg.content };

/** `complete` replaces the chat's history with `messages`, so one chat answers both conversations. */
const askNW = async (chat: NWChat, messages: ChatMessage[]): Promise<string> => {
  const reply = await chat.complete(messages.map(toNWMessage)).completed();
  return reply.trim();
};

interface ReplyProps {
  label: string;
  verdict: string;
  found: boolean;
  text: string;
}

/** One model reply shown under the Run button, with its verdict. */
const Reply: React.FC<ReplyProps> = ({ label, verdict, found, text }) => (
  <View style={styles.replyContainer}>
    <Text style={styles.replyLabel}>{label}</Text>
    <Text style={[styles.replyVerdict, { color: found ? AppColors.accentGreen : AppColors.error }]}>
      {verdict}
    </Text>
    <Text style={styles.replyText} selectable>
      {text || '(empty reply)'}
    </Text>
  </View>
);

/** One engine's replies to the tool-message conversation and its control. */
const EngineResult: React.FC<{ engine: string; replies: Replies }> = ({ engine, replies }) => (
  <>
    <Text style={styles.historyLine}>{engine}:</Text>
    <Reply
      label="Tool result in a tool message"
      verdict={
        replies.chatHistoryReply.includes(EXPECT)
          ? `✅ "${EXPECT}" found: the tool message reached the model`
          : `❌ "${EXPECT}" missing: the tool message was dropped`
      }
      found={replies.chatHistoryReply.includes(EXPECT)}
      text={' '}
    />
    <Reply
      label="Control: tool result in the user message"
      verdict={
        replies.controlReply.includes(EXPECT)
          ? `✅ "${EXPECT}" found: the model answers once the fact reaches it`
          : `❌ "${EXPECT}" missing: the model fails even with the fact`
      }
      found={replies.controlReply.includes(EXPECT)}
      text={' '}
    />
  </>
);

export const HistoryRolesScreen: React.FC = () => {
  const modelService = useModelService();
  const [result, setResult] = useState<EngineReplies | string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const run = async () => {
    setIsRunning(true);
    let nwChat: NWChat | null = null;
    try {
      console.log(CHAT_HISTORY.slice(0, 2));
      const chatHistoryReply = await askRA(CHAT_HISTORY);
      console.log(`chatHistoryReply ${chatHistoryReply}`);
      const controlReply = await askRA(CONTROL_HISTORY);
      console.log(`controlReply ${controlReply}`);

      // Greedy with thinking off, like `askRA`.
      nwChat = new NWChat({
        model: modelService.nwModel!,
        sampler: SamplerPresets.greedy(),
        templateVariables: { enable_thinking: false },
      });
      const nwChatHistoryReply = await askNW(nwChat, CHAT_HISTORY);
      const nwControlReply = await askNW(nwChat, CONTROL_HISTORY);

      setResult({
        runAnywhere: { chatHistoryReply, controlReply },
        nobodyWho: { chatHistoryReply: nwChatHistoryReply, controlReply: nwControlReply },
      });
    } catch (e) {
      setResult(String(e));
    } finally {
      nwChat?.destroy();
      setIsRunning(false);
    }
  };

  if (!modelService.isLLMLoaded || modelService.nwModelId !== MODEL_IDS.llm) {
    const raBusy = modelService.isLLMDownloading || modelService.isLLMLoading;

    return (
      <ModelLoaderWidget
        modelCredit={MODEL_CREDITS.llm}
        title="LLM Model Required"
        subtitle="Load the same model in RunAnywhere and NobodyWho to test history handling"
        icon="chat"
        accentColor={ACCENT}
        isDownloading={raBusy ? modelService.isLLMDownloading : modelService.isNWDownloading}
        isLoading={raBusy ? modelService.isLLMLoading : modelService.isNWLoading}
        progress={raBusy ? modelService.llmDownloadProgress : modelService.nwDownloadProgress}
        progressLabel={raBusy ? 'RunAnywhere' : 'NobodyWho'}
        onLoad={async () => {
          if (!modelService.isLLMLoaded) {
            await modelService.downloadAndLoadLLM();
          }
          await modelService.downloadAndLoadNW(MODEL_IDS.llm);
        }}
      />
    );
  }

  return (
    <ScrollView style={styles.screenContainer} contentContainerStyle={styles.contentContainer}>
      <FindingHeader
        title="Roles are lost"
        claim={
          'RunAnywhere turns history into a list of alternating user and assistant strings. ' +
          '`tool` messages and mid-conversation `system` messages are dropped, so the model ' +
          'never sees them.'
        }
      />

      <View>
        {CHAT_HISTORY.map((msg, index) => (
          <Text key={index} style={styles.historyLine}>
            <Text style={styles.roleLabel}>{msg.role}</Text>: {msg.content}
          </Text>
        ))}
      </View>
      <ActionButton
        label="Ask for the tracking number"
        onPress={run}
        busy={isRunning}
        disabled={isRunning}
        accentColor={ACCENT}
      />
      {typeof result === 'string' ? (
        <View style={styles.resultContainer}>
          <Reply label="Generation failed" verdict="❌ Error" found={false} text={result} />
        </View>
      ) : result ? (
        <View style={styles.resultContainer}>
          <EngineResult engine="RunAnywhere" replies={result.runAnywhere} />
          <EngineResult engine="NobodyWho" replies={result.nobodyWho} />
        </View>
      ) : null}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  screenContainer: {
    flex: 1,
    backgroundColor: AppColors.primaryDark,
  },
  contentContainer: {
    padding: 16,
    paddingBottom: 40,
  },
  resultContainer: {
    marginTop: 4,
    marginBottom: 16,
    gap: 14,
  },
  replyContainer: {
    gap: 4,
  },
  historyLine: {
    marginBottom: 4,
    color: AppColors.textPrimary,
  },
  roleLabel: {
    fontWeight: 'bold',
    color: AppColors.textPrimary,
  },
  replyLabel: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    color: AppColors.textMuted,
  },
  replyVerdict: {
    fontSize: 15,
    fontWeight: '600',
  },
  replyText: {
    fontFamily: MONO,
    fontSize: 15,
    lineHeight: 18,
    color: AppColors.textSecondary,
  },
});
