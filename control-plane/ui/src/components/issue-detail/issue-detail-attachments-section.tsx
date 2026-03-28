import { useRef, type ChangeEvent } from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { IssueAttachment } from "@hive/shared";
import { Button } from "@/components/ui/button";
import { Hexagon, Trash2 } from "lucide-react";

function isImageAttachment(attachment: IssueAttachment) {
  return attachment.contentType.startsWith("image/");
}

export function IssueDetailAttachmentsSection({
  attachments,
  attachmentError,
  uploadAttachment,
  deleteAttachment,
}: {
  attachments: IssueAttachment[] | undefined;
  attachmentError: string | null;
  uploadAttachment: UseMutationResult<IssueAttachment, Error, File, unknown>;
  deleteAttachment: UseMutationResult<unknown, Error, string, unknown>;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFilePicked = async (evt: ChangeEvent<HTMLInputElement>) => {
    const file = evt.target.files?.[0];
    if (!file) return;
    await uploadAttachment.mutateAsync(file);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">Attachments</h3>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={handleFilePicked}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadAttachment.isPending}
          >
            <Hexagon className="h-3.5 w-3.5 mr-1.5" />
            {uploadAttachment.isPending ? "Uploading..." : "Upload image"}
          </Button>
        </div>
      </div>

      {attachmentError && <p className="text-xs text-destructive">{attachmentError}</p>}

      {!attachments || attachments.length === 0 ? (
        <p className="text-xs text-muted-foreground">No attachments yet.</p>
      ) : (
        <div className="space-y-2">
          {attachments.map((attachment) => (
            <div key={attachment.id} className="border border-border rounded-md p-2">
              <div className="flex items-center justify-between gap-2">
                <a
                  href={attachment.contentPath}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs hover:underline truncate"
                  title={attachment.originalFilename ?? attachment.id}
                >
                  {attachment.originalFilename ?? attachment.id}
                </a>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-destructive cursor-pointer"
                  onClick={() => deleteAttachment.mutate(attachment.id)}
                  disabled={deleteAttachment.isPending}
                  title="Delete attachment"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {attachment.contentType} · {(attachment.byteSize / 1024).toFixed(1)} KB
              </p>
              {isImageAttachment(attachment) && (
                <a href={attachment.contentPath} target="_blank" rel="noreferrer">
                  <img
                    src={attachment.contentPath}
                    alt={attachment.originalFilename ?? "attachment"}
                    className="mt-2 max-h-56 rounded border border-border object-contain bg-accent/10"
                    loading="lazy"
                  />
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
