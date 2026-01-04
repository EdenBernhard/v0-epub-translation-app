-- Add original_content column to store EPUB content for later translation
ALTER TABLE public.epub_files 
ADD COLUMN IF NOT EXISTS original_content JSONB;

-- Update existing records (if any) to have empty content structure
UPDATE public.epub_files 
SET original_content = '{}'::jsonb 
WHERE original_content IS NULL;
