-- NOTE: Prisma's diff proposed dropping complaint_title_trgm and
-- complaint_desc_trgm here and both DROP statements were removed by hand.
--
-- Those two are pg_trgm GIN indexes created in the db_constraints migration and
-- they back complaint search. Prisma's schema language cannot express a GIN
-- index with an operator class, so every future migration will propose dropping
-- them again — read the generated SQL before applying it.

-- AlterTable
ALTER TABLE "Department" ADD COLUMN     "address" TEXT,
ADD COLUMN     "phone" TEXT;
