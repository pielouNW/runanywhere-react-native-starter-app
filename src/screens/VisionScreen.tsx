import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Image,
  TextInput,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from 'react-native';
import * as RNFS from 'react-native-fs';
import { AppColors } from '../theme';
import { useModelService, MODEL_CREDITS } from '../services/ModelService';
import { ChatMessageBubble, ChatMessage, ModelLoaderWidget } from '../components';
import { VLMService } from '../services/VLMService';

// Small, describable sample photos. Selecting one downloads it to the app's
// cache directory and feeds the on-disk path to the VLM (which reads image
// files directly via VLM_IMAGE_FORMAT_FILE_PATH). Users can also paste a
// custom image URL or a local file path.
const SAMPLE_IMAGES: ReadonlyArray<{ id: string; label: string; url: string }> = [
  { id: 'dog', label: '🐶 Dog', url: 'https://picsum.photos/id/237/512/512' },
  { id: 'nature', label: '🏔 Nature', url: 'https://picsum.photos/id/1015/512/512' },
  { id: 'city', label: '🏙 City', url: 'https://picsum.photos/id/1067/512/512' },
];

const DEFAULT_PROMPT = 'Describe what you see in this image.';
const MAX_TOKENS = 200;

/**
 * Resolve an image source (remote URL or local path) to a plain on-disk file
 * path the native VLM backend can read.
 */
const resolveImageToLocalPath = async (source: string): Promise<string> => {
  const trimmed = source.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const destination = `${RNFS.CachesDirectoryPath}/vlm_input_${Date.now()}.jpg`;
    const { promise } = RNFS.downloadFile({
      fromUrl: trimmed,
      toFile: destination,
    });
    const result = await promise;
    if (result.statusCode && result.statusCode >= 400) {
      throw new Error(`Failed to download image (HTTP ${result.statusCode})`);
    }
    return destination;
  }
  // Local path — strip any file:// scheme prefix.
  return trimmed.replace('file://', '');
};

const errorMessage = (text: string): ChatMessage => ({
  text,
  isUser: false,
  timestamp: new Date(),
  isError: true,
});

export const VisionScreen: React.FC = () => {
  const modelService = useModelService();
  const vlmService = useMemo(() => new VLMService(), []);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [customSource, setCustomSource] = useState('');
  // The source the current image came from, and its resolved on-disk path.
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [isLoadingImage, setIsLoadingImage] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentResponse, setCurrentResponse] = useState('');
  const flatListRef = useRef<FlatList>(null);
  const responseRef = useRef('');
  const wasCancelledRef = useRef(false);

  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [messages, currentResponse]);

  /** Download/resolve an image and make it the one questions are asked about. */
  const selectImage = async (source: string): Promise<string | null> => {
    const trimmed = source.trim();
    if (!trimmed || isLoadingImage) return null;

    setIsLoadingImage(true);
    try {
      const localPath = await resolveImageToLocalPath(trimmed);
      setSelectedSource(trimmed);
      setImagePath(localPath);
      return localPath;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMessages(prev => [...prev, errorMessage(`Error: ${message}`)]);
      return null;
    } finally {
      setIsLoadingImage(false);
    }
  };

  const handleSelectSample = (url: string) => {
    // A sample replaces any typed URL, so Ask doesn't switch back to it.
    setCustomSource('');
    selectImage(url);
  };

  const handleAsk = async () => {
    const text = prompt.trim();
    if (!text || isProcessing || isLoadingImage) return;

    // A typed URL/path that hasn't been loaded yet takes over from the current image.
    const source = customSource.trim();
    let path = imagePath;
    if (source && source !== selectedSource) {
      path = await selectImage(source);
      if (!path) return;
    }
    if (!path) {
      setMessages(prev => [
        ...prev,
        errorMessage('Pick a sample image or enter an image URL first. The vision model needs an image to answer.'),
      ]);
      return;
    }

    setMessages(prev => [...prev, { text, isUser: true, timestamp: new Date() }]);
    setPrompt('');
    setIsProcessing(true);
    setCurrentResponse('');
    responseRef.current = '';
    wasCancelledRef.current = false;

    try {
      const result = await vlmService.processImage(path, text, MAX_TOKENS, (token) => {
        responseRef.current += token;
        setCurrentResponse(responseRef.current);
      });
      setMessages(prev => [
        ...prev,
        {
          text: result?.text || responseRef.current,
          isUser: false,
          timestamp: new Date(),
          tokensPerSecond: result?.tokensPerSecond,
          totalTokens: result?.outputTokens,
          wasCancelled: wasCancelledRef.current,
        },
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMessages(prev => [...prev, errorMessage(`Error: ${message}`)]);
    } finally {
      setCurrentResponse('');
      responseRef.current = '';
      wasCancelledRef.current = false;
      setIsProcessing(false);
    }
  };

  const handleStop = () => {
    wasCancelledRef.current = true;
    vlmService.cancel();
  };

  // Gate the screen on a loaded vision model, mirroring the other screens.
  if (!modelService.isVLMLoaded) {
    return (
      <ModelLoaderWidget
        modelCredit={MODEL_CREDITS.vlm}
        title="Vision Model Required"
        subtitle="Download and load the vision-language model to describe images"
        icon="vision"
        accentColor={AppColors.accentOrange}
        isDownloading={modelService.isVLMDownloading}
        isLoading={modelService.isVLMLoading}
        progress={modelService.vlmDownloadProgress}
        onLoad={modelService.downloadAndLoadVLM}
      />
    );
  }

  const isBusy = isProcessing || isLoadingImage;
  const canAsk = prompt.trim().length > 0;

  const header = (
    <View style={styles.headerContainer}>
      {/* Image Preview */}
      <View style={styles.previewContainer}>
        {imagePath ? (
          <Image
            source={{ uri: `file://${imagePath}` }}
            style={styles.previewImage}
            resizeMode="cover"
          />
        ) : (
          <View style={styles.previewPlaceholderContainer}>
            <Text style={styles.previewIcon}>🖼</Text>
            <Text style={styles.previewHint}>
              Pick a sample image or paste an image URL below
            </Text>
          </View>
        )}
        {isLoadingImage && (
          <View style={styles.loadingOverlayContainer}>
            <ActivityIndicator size="small" color="#FFFFFF" />
            <Text style={styles.loadingText}>Loading image...</Text>
          </View>
        )}
      </View>

      {/* Sample images */}
      <Text style={styles.sectionLabel}>Sample Images</Text>
      <View style={styles.sampleRowContainer}>
        {SAMPLE_IMAGES.map((sample) => (
          <TouchableOpacity
            key={sample.id}
            style={[
              styles.sampleChipContainer,
              selectedSource === sample.url && styles.sampleChipSelectedContainer,
            ]}
            onPress={() => handleSelectSample(sample.url)}
            disabled={isBusy}
            activeOpacity={0.8}
          >
            <Text style={styles.sampleChipText}>{sample.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Custom source */}
      <Text style={styles.sectionLabel}>Custom Image URL or Path</Text>
      <TextInput
        style={styles.sourceInput}
        placeholder="https://... or /path/to/image.jpg"
        placeholderTextColor={AppColors.textMuted}
        value={customSource}
        onChangeText={setCustomSource}
        onSubmitEditing={() => selectImage(customSource)}
        returnKeyType="done"
        autoCapitalize="none"
        autoCorrect={false}
        editable={!isBusy}
      />
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      <FlatList
        ref={flatListRef}
        data={[
          ...messages,
          ...(isProcessing
            ? [{ text: currentResponse || '...', isUser: false, timestamp: new Date() }]
            : []),
        ]}
        renderItem={({ item, index }) => (
          <ChatMessageBubble
            message={item as ChatMessage}
            isStreaming={isProcessing && index === messages.length}
          />
        )}
        keyExtractor={(_, index) => index.toString()}
        ListHeaderComponent={header}
        contentContainerStyle={styles.messageListContainer}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      />

      {/* Input bar */}
      <View style={styles.inputBarContainer}>
        <TextInput
          style={styles.promptInput}
          placeholder="Ask about the image..."
          placeholderTextColor={AppColors.textMuted}
          value={prompt}
          onChangeText={setPrompt}
          editable={!isProcessing}
          multiline
        />
        {isProcessing ? (
          <TouchableOpacity
            style={[styles.actionButtonContainer, styles.stopButtonContainer]}
            onPress={handleStop}
            activeOpacity={0.85}
          >
            <Text style={styles.actionButtonText}>Stop</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[
              styles.actionButtonContainer,
              !canAsk && styles.actionButtonDisabledContainer,
            ]}
            onPress={handleAsk}
            disabled={!canAsk}
            activeOpacity={0.85}
          >
            <Text style={styles.actionButtonText}>Ask</Text>
          </TouchableOpacity>
        )}
      </View>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: AppColors.primaryDark,
  },
  messageListContainer: {
    paddingBottom: 16,
  },
  headerContainer: {
    padding: 20,
    paddingBottom: 8,
  },
  previewContainer: {
    height: 240,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: AppColors.surfaceCard,
    borderWidth: 1,
    borderColor: AppColors.accentOrange + '33',
    marginBottom: 20,
    position: 'relative',
  },
  previewImage: {
    width: '100%',
    height: '100%',
  },
  previewPlaceholderContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  previewIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  previewHint: {
    fontSize: 13,
    color: AppColors.textSecondary,
    textAlign: 'center',
  },
  loadingOverlayContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  loadingText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: AppColors.textMuted,
    marginBottom: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sampleRowContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 20,
  },
  sampleChipContainer: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: AppColors.surfaceCard,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: AppColors.accentOrange + '40',
  },
  sampleChipSelectedContainer: {
    backgroundColor: AppColors.accentOrange + '33',
    borderColor: AppColors.accentOrange,
  },
  sampleChipText: {
    fontSize: 14,
    color: AppColors.textPrimary,
    fontWeight: '500',
  },
  sourceInput: {
    backgroundColor: AppColors.surfaceCard,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 14,
    color: AppColors.textPrimary,
    borderWidth: 1,
    borderColor: AppColors.textMuted + '1A',
    marginBottom: 12,
  },
  inputBarContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 16,
    backgroundColor: AppColors.surfaceCard + 'CC',
    borderTopWidth: 1,
    borderTopColor: AppColors.textMuted + '1A',
  },
  promptInput: {
    flex: 1,
    backgroundColor: AppColors.primaryMid,
    borderRadius: 24,
    paddingHorizontal: 20,
    paddingVertical: 12,
    fontSize: 15,
    color: AppColors.textPrimary,
    maxHeight: 100,
  },
  actionButtonContainer: {
    height: 48,
    paddingHorizontal: 24,
    borderRadius: 24,
    backgroundColor: AppColors.accentOrange,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionButtonDisabledContainer: {
    opacity: 0.4,
  },
  stopButtonContainer: {
    backgroundColor: AppColors.error,
  },
  actionButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFFFFF',
  },
});
