-- Remove any seeded demo inventory so books start empty and configurable.
DELETE FROM book_sales;
DELETE FROM book_restock_history;
DELETE FROM books;
