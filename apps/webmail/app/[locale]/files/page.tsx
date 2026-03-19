"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { useFileStore } from "@/stores/file-store";
import { toast } from "@/stores/toast-store";
import { cn } from "@/lib/utils";
import { NavigationRail } from "@/components/layout/navigation-rail";
import { SidebarAppsModal } from "@/components/layout/sidebar-apps-modal";
import { InlineAppView } from "@/components/layout/inline-app-view";
import { useSidebarApps } from "@/hooks/use-sidebar-apps";
import { useIsMobile } from "@/hooks/use-media-query";
import { FileBrowser } from "@/components/files/file-browser";
import { ImagePreviewModal } from "@/components/files/image-preview-modal";
import { FilePreviewModal } from "@/components/files/file-preview-modal";
import { loadFilesSettings } from "@/components/files/files-settings-dialog";
import type { FolderLayout } from "@/components/files/files-settings-dialog";

export default function FilesPage() {
  const router = useRouter();
  const t = useTranslations("files");
  const { isAuthenticated, logout, checkAuth, isLoading: authLoading, client } = useAuthStore();
  const { showAppsModal, inlineApp, loadedApps, handleManageApps, handleInlineApp, closeInlineApp, closeAppsModal } = useSidebarApps();
  const [initialCheckDone, setInitialCheckDone] = useState(() => useAuthStore.getState().isAuthenticated && !!useAuthStore.getState().client);
  const { quota, isPushConnected } = useEmailStore();
  const {
    currentPath,
    resources,
    isLoading,
    error,
    supportsFiles,
    selectedResources,
    uploadProgress,
    clipboard,
    initClient,
    checkSupport,
    navigate,
    navigateByPath,
    refresh,
    createDirectory,
    uploadFile,
    uploadFiles,
    uploadFolder,
    deleteResource,
    deleteResources,
    renameResource,
    downloadResource,
    getImageUrl,
    getFileContent,
    createTextFile,
    duplicateResource,
    downloadResources,
    moveToFolder,
    moveToParent,
    cutResources,
    copyResources,
    pasteResources,
    selectResource,
    toggleSelect,
    selectAll,
    clearSelection,
    setSelection,
    listPath,
    listByParentId,
    favorites,
    recentFiles,
    toggleFavorite,
    addRecentFile,
    cancelUpload,
    undoLastAction,
    lastAction,
  } = useFileStore();

  const isMobile = useIsMobile();
  const [folderLayout, setFolderLayout] = useState<FolderLayout>(() => loadFilesSettings().folderLayout);
  const hasFetched = useRef(false);

  // Sync folderLayout when settings change
  useEffect(() => {
    const reload = () => setFolderLayout(loadFilesSettings().folderLayout);
    const handleStorage = (e: StorageEvent) => { if (e.key === "files-settings") reload(); };
    window.addEventListener("storage", handleStorage);
    window.addEventListener("files-settings-changed", reload);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("files-settings-changed", reload);
    };
  }, []);
  const { dialogProps: confirmDialogProps, confirm: confirmDialog } = useConfirmDialog();
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [detailName, setDetailName] = useState<string | null>(null);

  const detailResource = detailName ? resources.find(r => r.name === detailName) || null : null;

  // Check auth on mount
  useEffect(() => {
    checkAuth().finally(() => {
      setInitialCheckDone(true);
    });
  }, [checkAuth]);

  // Redirect if not authenticated
  useEffect(() => {
    if (initialCheckDone && !isAuthenticated && !authLoading) {
      try { sessionStorage.setItem('redirect_after_login', window.location.pathname); } catch { /* ignore */ }
      router.push("/login");
    }
  }, [initialCheckDone, isAuthenticated, authLoading, router]);

  // Initialize JMAP files client
  useEffect(() => {
    if (isAuthenticated && client && !hasFetched.current) {
      hasFetched.current = true;
      initClient(client);
    }
  }, [isAuthenticated, client, initClient]);

  // Check support and load root after client is initialized
  const storeClient = useFileStore(s => s.client);
  useEffect(() => {
    if (storeClient && supportsFiles === null) {
      checkSupport().then((supported) => {
        if (supported) {
          navigate(null);
        }
      });
    }
  }, [storeClient, supportsFiles, checkSupport, navigate]);

  const handleNavigate = useCallback((path: string, resourceId?: string | null) => {
    if (resourceId !== undefined) {
      // Direct ID-based navigation (directory click, breadcrumb dropdown folder)
      navigate(resourceId, path.split('/').pop() || '');
    } else {
      // Path-based navigation (breadcrumbs, favorites, recent files)
      navigateByPath(path);
    }
  }, [navigate, navigateByPath]);

  const handleCreateFolder = useCallback(async (name: string) => {
    try {
      await createDirectory(name);
      toast.success(t("create_folder_success"));
    } catch (err) {
      console.error("Failed to create folder:", err);
      toast.error(t("create_folder_error"));
    }
  }, [createDirectory, t]);

  const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB

  const handleUploadFiles = useCallback(async (files: File[]) => {
    const oversized = files.filter(f => f.size > MAX_FILE_SIZE);
    const valid = files.filter(f => f.size <= MAX_FILE_SIZE);
    if (oversized.length > 0) {
      toast.error(t("file_too_large", { name: oversized[0].name, max: "500 MB" }));
    }
    if (valid.length === 0) return;
    try {
      await uploadFiles(valid);
      toast.success(t("upload_success", { count: valid.length }));
    } catch (err) {
      console.error("Failed to upload files:", err);
      toast.error(t("upload_error"));
    }
  }, [uploadFiles, t]);

  const handleUploadFolder = useCallback(async (files: File[]) => {
    const oversized = files.filter(f => f.size > MAX_FILE_SIZE);
    const valid = files.filter(f => f.size <= MAX_FILE_SIZE);
    if (oversized.length > 0) {
      toast.error(t("file_too_large", { name: oversized[0].name, max: "500 MB" }));
    }
    if (valid.length === 0) return;
    try {
      await uploadFolder(valid);
      toast.success(t("upload_success", { count: valid.length }));
    } catch (err) {
      console.error("Failed to upload folder:", err);
      toast.error(t("upload_error"));
    }
  }, [uploadFolder, t]);

  const handleDelete = useCallback(async (name: string) => {
    const confirmed = await confirmDialog({
      title: t("delete_confirm_title"),
      message: t("delete_confirm_message", { name }),
      confirmText: t("delete"),
      variant: "destructive",
    });
    if (!confirmed) return;

    try {
      await deleteResource(name);
      toast.success(t("delete_success"));
    } catch (err) {
      console.error("Failed to delete:", err);
      toast.error(t("delete_error"));
    }
  }, [deleteResource, confirmDialog, t]);

  const handleBatchDelete = useCallback(async (names: string[]) => {
    const confirmed = await confirmDialog({
      title: t("delete_confirm_title"),
      message: t("batch_delete_confirm_message", { count: names.length }),
      confirmText: t("delete"),
      variant: "destructive",
    });
    if (!confirmed) return;

    try {
      await deleteResources(names);
      toast.success(t("batch_delete_success", { count: names.length }));
    } catch (err) {
      console.error("Failed to batch delete:", err);
      toast.error(t("delete_error"));
    }
  }, [deleteResources, confirmDialog, t]);

  const handleUndo = useCallback(async () => {
    try {
      await undoLastAction();
      toast.success(t("undo_success"));
    } catch (err) {
      console.error("Failed to undo:", err);
      toast.error(t("undo_error"));
    }
  }, [undoLastAction, t]);

  const handleRename = useCallback(async (oldName: string, newName: string) => {
    try {
      await renameResource(oldName, newName);
      toast.success(t("rename_success"), {
        action: { label: t("undo"), onClick: handleUndo },
      });
    } catch (err) {
      console.error("Failed to rename:", err);
      toast.error(t("rename_error"));
    }
  }, [renameResource, t, handleUndo]);

  const findResourceId = useCallback((name: string) => {
    const r = resources.find(res => res.name === name);
    return r?.id || name;
  }, [resources]);

  const handleDownload = useCallback(async (name: string) => {
    try {
      await downloadResource(name);
      addRecentFile(name, findResourceId(name));
    } catch (err) {
      console.error("Failed to download:", err);
      toast.error(t("download_error"));
    }
  }, [downloadResource, addRecentFile, findResourceId, t]);

  const handleBatchDownload = useCallback(async (names: string[]) => {
    try {
      await downloadResources(names);
    } catch (err) {
      console.error("Failed to batch download:", err);
      toast.error(t("download_error"));
    }
  }, [downloadResources, t]);

  const handleCreateTextFile = useCallback(async (name: string) => {
    try {
      await createTextFile(name);
      toast.success(t("create_file_success"));
    } catch (err) {
      console.error("Failed to create file:", err);
      toast.error(t("create_file_error"));
    }
  }, [createTextFile, t]);

  const handleDuplicate = useCallback(async (name: string) => {
    try {
      await duplicateResource(name);
      toast.success(t("duplicate_success"));
    } catch (err) {
      console.error("Failed to duplicate:", err);
      toast.error(t("duplicate_error"));
    }
  }, [duplicateResource, t]);

  const handleMoveToFolder = useCallback(async (names: string[], targetFolder: string) => {
    try {
      await moveToFolder(names, targetFolder);
      toast.success(t("move_success", { count: names.length }), {
        action: { label: t("undo"), onClick: handleUndo },
      });
    } catch (err) {
      console.error("Failed to move:", err);
      toast.error(t("move_error"));
    }
  }, [moveToFolder, t, handleUndo]);

  const handleMoveToParent = useCallback(async (names: string[]) => {
    try {
      await moveToParent(names);
      toast.success(t("move_success", { count: names.length }), {
        action: { label: t("undo"), onClick: handleUndo },
      });
    } catch (err) {
      console.error("Failed to move:", err);
      toast.error(t("move_error"));
    }
  }, [moveToParent, t, handleUndo]);

  const handlePaste = useCallback(async () => {
    try {
      await pasteResources();
      toast.success(t("paste_success"), {
        action: lastAction ? { label: t("undo"), onClick: handleUndo } : undefined,
      });
    } catch (err) {
      console.error("Failed to paste:", err);
      toast.error(t("paste_error"));
    }
  }, [pasteResources, t, lastAction, handleUndo]);

  const handlePreviewImage = useCallback((name: string) => {
    setPreviewImage(name);
    addRecentFile(name, findResourceId(name));
  }, [addRecentFile, findResourceId]);

  const handlePreviewFile = useCallback((name: string) => {
    setPreviewFile(name);
    addRecentFile(name, findResourceId(name));
  }, [addRecentFile, findResourceId]);

  const handleShowDetails = useCallback((name: string) => {
    setDetailName(name);
    setShowDetails(true);
  }, []);

  const handleToggleDetails = useCallback(() => {
    setShowDetails(v => !v);
  }, []);

  if (!isAuthenticated) return null;

  return (
    <div className="flex h-dvh bg-background overflow-hidden">
      {!isMobile && (
        <div className="w-14 bg-secondary flex flex-col flex-shrink-0" style={{ borderRight: '1px solid rgba(128, 128, 128, 0.3)' }}>
          <NavigationRail
            collapsed
            quota={quota}
            isPushConnected={isPushConnected}
            onLogout={() => { logout(); if (!useAuthStore.getState().isAuthenticated) router.push('/login'); }}
            onManageApps={handleManageApps}
            onInlineApp={handleInlineApp}
            onCloseInlineApp={closeInlineApp}
            activeAppId={inlineApp?.id ?? null}
          />
        </div>
      )}

      <div className="flex flex-col flex-1 min-w-0">
        {inlineApp && (
          <InlineAppView apps={loadedApps} activeAppId={inlineApp!.id} onClose={closeInlineApp} />
        )}
        <div className={cn("flex flex-1 min-h-0", inlineApp && "hidden")}>
          <div className="flex-1 min-w-0 flex flex-col">
            {folderLayout !== "sidebar" && (
              <div className={cn("p-4 border-b border-border", isMobile && "px-3 py-3")}>
                <div className="flex items-center justify-between">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => router.push("/")}
                    className="justify-start"
                  >
                    <ArrowLeft className="w-4 h-4 mr-2" />
                    {t("title")}
                  </Button>
                </div>
              </div>
            )}

            <div className="flex-1 min-h-0">
              {supportsFiles === false ? (
                <div className="flex items-center justify-center h-full">
                  <p className="text-sm text-muted-foreground">{t("not_available")}</p>
                </div>
              ) : (
                <FileBrowser
                  currentPath={currentPath}
                  resources={resources}
                  isLoading={isLoading}
                  error={error}
                  selectedResources={selectedResources}
                  uploadProgress={uploadProgress}
                  clipboard={clipboard}
                  onNavigate={handleNavigate}
                  onCreateFolder={handleCreateFolder}
                  onUploadFiles={handleUploadFiles}
                  onUploadFolder={handleUploadFolder}
                  onCancelUpload={cancelUpload}
                  onDelete={handleDelete}
                  onBatchDelete={handleBatchDelete}
                  onRename={handleRename}
                  onDownload={handleDownload}
                  onBatchDownload={handleBatchDownload}
                  onRefresh={refresh}
                  onSelectResource={selectResource}
                  onToggleSelect={toggleSelect}
                  onSelectAll={selectAll}
                  onClearSelection={clearSelection}
                  onSetSelection={setSelection}
                  onCut={cutResources}
                  onCopy={copyResources}
                  onPaste={handlePaste}
                  onMoveToFolder={handleMoveToFolder}
                  onMoveToParent={handleMoveToParent}
                  onPreviewImage={handlePreviewImage}
                  onPreviewFile={handlePreviewFile}
                  onShowDetails={handleShowDetails}
                  onCreateTextFile={handleCreateTextFile}
                  onDuplicate={handleDuplicate}
                  getImageUrl={getImageUrl}
                  listPath={listPath}
                  listByParentId={listByParentId}
                  favorites={favorites}
                  recentFiles={recentFiles}
                  onToggleFavorite={toggleFavorite}
                  showDetails={showDetails}
                  onToggleDetails={handleToggleDetails}
                  detailResource={detailResource}
                />
              )}
            </div>
          </div>
        </div>

        {isMobile && (
          <NavigationRail
            orientation="horizontal"
            onManageApps={handleManageApps}
            onInlineApp={handleInlineApp}
            onCloseInlineApp={closeInlineApp}
            activeAppId={inlineApp?.id ?? null}
          />
        )}
      </div>

      {/* Image preview modal */}
      {previewImage && (
        <ImagePreviewModal
          name={previewImage}
          onClose={() => setPreviewImage(null)}
          onDownload={handleDownload}
          getImageUrl={getImageUrl}
        />
      )}

      {/* File preview modal (text, PDF, audio, video, markdown) */}
      {previewFile && (
        <FilePreviewModal
          name={previewFile}
          onClose={() => setPreviewFile(null)}
          onDownload={() => handleDownload(previewFile)}
          getFileContent={() => getFileContent(previewFile)}
        />
      )}

      <SidebarAppsModal isOpen={showAppsModal} onClose={closeAppsModal} />
      <ConfirmDialog {...confirmDialogProps} />
    </div>
  );
}
