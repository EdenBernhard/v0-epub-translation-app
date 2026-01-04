-- Add translation_status column to epub_files table
ALTER TABLE public.epub_files 
ADD COLUMN IF NOT EXISTS translation_status TEXT DEFAULT 'none';

-- Update existing records to set their status
UPDATE public.epub_files 
SET translation_status = CASE 
  WHEN id IN (SELECT epub_file_id FROM translations) THEN 'completed'
  ELSE 'none'
END;

-- Add index for faster queries
CREATE INDEX IF NOT EXISTS idx_epub_files_translation_status ON public.epub_files(translation_status);
